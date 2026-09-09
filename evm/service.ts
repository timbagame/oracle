import { randomBytes } from "node:crypto";
import {
  evmIntentSchema as intentSchema,
  evmPrivateJoinSchema as privateJoinSchema,
} from "@timbagame/protocol/evm";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  keccak256,
  toHex,
  zeroHash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  timbaAbi,
  completeGameTransaction,
  commitmentFor,
  creationTypedData,
  privateJoinTypedData,
  gameIdFor,
  decodeEvmGameEvent,
  type CreateGameRequest,
} from "@timbagame/protocol/evm/v0.1.0";
import { gameLifecycle, observeEvmGame, transactionProgress } from "@timbagame/protocol/games";
import { tokenPolicy, type EvmConfig } from "./config.ts";
import { EvmStore, json } from "./store.ts";

export {
  evmIntentSchema as intentSchema,
  evmPrivateJoinSchema as privateJoinSchema,
} from "@timbagame/protocol/evm";
export class EvmService {
  readonly publicClient;
  readonly wallet;
  private busy = false;
  lastCycleAt = 0;
  lastCycleFailed = false;
  constructor(
    readonly config: EvmConfig,
    key: Hex,
    readonly store: EvmStore,
  ) {
    const chain = defineChain({
      id: config.chainId,
      name: "Timba configured EVM",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: config.rpcUrls } },
    });
    const transport = fallback(
      config.rpcUrls.map((url) => http(url, { timeout: 3_000, retryCount: 0 })),
      { rank: false, retryCount: 0 },
    );
    this.publicClient = createPublicClient({ chain, transport });
    this.wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
  }
  async validateDeployment() {
    if ((await this.publicClient.getChainId()) !== this.config.chainId)
      throw new Error("EVM RPC chain mismatch");
    const owner = await this.publicClient.readContract({
      address: this.config.address,
      abi: timbaAbi,
      functionName: "owner",
    });
    if (owner.toLowerCase() !== this.wallet.account.address.toLowerCase())
      throw new Error("EVM operator does not own configured proxy");
  }
  async authorize(input: unknown): Promise<{ gameId: Hex; request: unknown; signature: Hex }> {
    const parsed = intentSchema.parse(input);
    const { proof, ...wire } = parsed;
    const request: CreateGameRequest = {
      ...wire,
      amount: BigInt(wire.amount),
      nonce: BigInt(wire.nonce),
      deadline: BigInt(wire.deadline),
      commitment: zeroHash,
    };
    const now = (await this.publicClient.getBlock()).timestamp;
    if (request.deadline <= now || request.deadline > now + 300n)
      throw new Error("Authorization expires within five minutes");
    const limits = await this.publicClient.readContract({
      address: this.config.address,
      abi: timbaAbi,
      functionName: "config",
    });
    if (
      request.timeout < limits[2] ||
      request.timeout > limits[3] ||
      request.maxPlayers > limits[4]
    )
      throw new Error("Game exceeds current oracle limits");
    const policy = tokenPolicy(this.config, request.token);
    if (
      request.amount < BigInt(policy.minimumAmount) ||
      request.minPlayers < (request.gameType === 0 ? 2 : 1) ||
      request.maxPlayers < request.minPlayers ||
      (request.gameType === 0 && request.amount > (2n ** 256n - 1n) / BigInt(request.maxPlayers))
    )
      throw new Error("Invalid game terms");
    if (
      !(await this.publicClient.verifyTypedData({
        address: request.creator,
        ...creationTypedData(this.config, request),
        signature: proof,
      }))
    )
      throw new Error("Invalid creator proof");
    const nonce = await this.publicClient.readContract({
      address: this.config.address,
      abi: timbaAbi,
      functionName: "creationNonces",
      args: [request.creator],
    });
    if (nonce !== request.nonce) throw new Error("Creation nonce changed; reload wallet state");
    const id = gameIdFor(this.config, request.creator, request.nonce);
    // One immutable secret per creator nonce, even if the creator changes an unsubmitted draft.
    // The contract permits only one creation at this nonce; previously signed alternatives
    // can never produce two games or reuse the reveal in a later nonce.
    const intent = json({ ...request, deadline: 0n });
    const existing = this.store.game(id);
    const secret = existing?.secret ?? toHex(randomBytes(32));
    const authorized = { ...request, commitment: commitmentFor(secret) };
    const signature = await this.wallet.signTypedData(creationTypedData(this.config, authorized));
    // Signing is local, with no yield between reading and durable persistence except signTypedData.
    const concurrent = this.store.game(id);
    if (concurrent && concurrent.secret !== secret) return this.authorize(input);
    this.store.save({ id, secret, intent, request: json(authorized), signature });
    return { gameId: id, request: JSON.parse(json(authorized)) as unknown, signature };
  }
  async privateJoin(input: unknown) {
    const request = privateJoinSchema.parse(input);
    const deadline = BigInt(request.deadline);
    const now = (await this.publicClient.getBlock()).timestamp;
    if (deadline <= now || deadline > now + 300n)
      throw new Error("Invitation expires within five minutes");
    const game = await this.game(request.gameId);
    if (!game.isPrivate || game.status !== 1) throw new Error("Private game unavailable");
    const data = privateJoinTypedData(this.config, request.gameId, request.player, deadline);
    // A private invitation is explicitly approved by the game creator, not merely anyone with a link.
    if (
      !(await this.publicClient.verifyTypedData({
        address: game.creator,
        ...data,
        signature: request.proof,
      }))
    )
      throw new Error("Invalid invitation");
    return { deadline: request.deadline, signature: await this.wallet.signTypedData(data) };
  }
  game(id: Hex) {
    return this.publicClient.readContract({
      address: this.config.address,
      abi: timbaAbi,
      functionName: "getGame",
      args: [id],
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    let failed = false;
    try {
      await this.validateDeployment();
      await this.index();
      const pending = this.store.pending();
      if (pending) {
        const receipt = await this.publicClient
          .getTransactionReceipt({ hash: pending.hash })
          .catch((error) => {
            if (error?.name === "TransactionReceiptNotFoundError") return null;
            throw error;
          });
        if (receipt) {
          const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
          if (
            transactionProgress(
              {
                success: receipt.status === "success",
                confirmations: Number(head - receipt.blockNumber + 1n),
              },
              this.config.confirmations,
            ) !== "submitted"
          )
            this.store.clearPending();
        } else {
          // Preserve the exact signed transaction across transport failures and process restarts.
          await this.publicClient
            .sendRawTransaction({ serializedTransaction: pending.raw })
            .catch(() => undefined);
        }
        return;
      }
      const block = await this.publicClient.getBlock();
      const limits = await this.publicClient.readContract({
        address: this.config.address,
        abi: timbaAbi,
        functionName: "config",
      });
      for (const row of this.store.games()) {
        try {
          this.store.defer(row.id, this.config.pollMs);
          const account = await this.game(row.id);
          if (
            account.status === 2 ||
            account.status === 3 ||
            (account.status === 0 &&
              block.timestamp >
                BigInt((JSON.parse(row.request) as { deadline: string }).deadline) + 300n)
          )
            this.store.defer(row.id, 86_400_000);
          const observation = observeEvmGame(
            {
              chain: "evm",
              chainId: BigInt(this.config.chainId),
              deployment: this.config.address,
              gameId: row.id,
            },
            account,
          );
          if (
            !observation.game ||
            !gameLifecycle(observation.game, block.timestamp, BigInt(limits[1])).canSettle
          )
            continue;
          const { request } = await this.publicClient.simulateContract({
            account: this.wallet.account,
            address: this.config.address,
            abi: timbaAbi,
            functionName: "completeGame",
            args: [row.id, row.secret],
          });
          const prepared = await this.wallet.prepareTransactionRequest({
            account: this.wallet.account,
            to: this.config.address,
            data: completeGameTransaction(this.config, row.id, row.secret).data,
            gas: await this.publicClient.estimateContractGas(request),
          });
          const raw = await this.wallet.signTransaction(prepared);
          this.store.submit({ game: row.id, raw, hash: keccak256(raw) });
          await this.publicClient.sendRawTransaction({ serializedTransaction: raw });
          break;
        } catch (error) {
          // One un-settleable token/game must not starve all other games.
          if (!(
            error instanceof BaseError &&
            error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof
              ContractFunctionRevertedError
          ))
            throw error;
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.lastCycleAt = Date.now();
      this.lastCycleFailed = failed;
      this.busy = false;
    }
  }
  async index() {
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    if (head < BigInt(this.config.confirmations)) return;
    const target = head - BigInt(this.config.confirmations) + 1n;
    const cursor = this.store.cursor();
    if (
      cursor &&
      (BigInt(cursor.block) > target ||
        (await this.publicClient.getBlock({ blockNumber: BigInt(cursor.block) })).hash !==
          cursor.hash)
    ) {
      this.store.resetIndex(); // Rebuild canonical events from deployment on a confirmed-chain reorganization.
      return;
    }
    const from = cursor ? BigInt(cursor.block) + 1n : BigInt(this.config.startBlock);
    if (from > target) return;
    const to = from + 499n < target ? from + 499n : target;
    const endBlock = await this.publicClient.getBlock({ blockNumber: to });
    const logs = await this.publicClient.getLogs({
      address: this.config.address,
      fromBlock: from,
      toBlock: to,
    });
    if ((await this.publicClient.getBlock({ blockNumber: to })).hash !== endBlock.hash) return;
    this.store.db.transaction(() => {
      for (const log of logs) {
        const event = decodeEvmGameEvent(this.config, { chainId: this.config.chainId, ...log });
        if (event)
          this.store.db.query("INSERT OR IGNORE INTO events VALUES (?,?,?,?)").run(
            Number(log.blockNumber),
            log.transactionHash,
            log.logIndex,
            json({
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              blockHash: log.blockHash,
              blockNumber: log.blockNumber,
              event,
            }),
          );
      }
      this.store.db
        .query(
          "INSERT INTO cursor VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET block=excluded.block,hash=excluded.hash",
        )
        .run(Number(to), endBlock.hash);
    })();
  }
}
