import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import {
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  zeroHash,
  type Hex,
} from "viem";
import {
  commitmentFor,
  completeGameTransaction,
  creationTypedData,
  gameIdFor,
  privateJoinTypedData,
  timbaAbi,
} from "@timbagame/protocol/evm/v0.1.0";
import {
  createFakeEvmService,
  creatorAccount,
  fakeGame,
  operatorAccount,
  playerAccount,
  PROXY,
  TOKEN,
} from "./helpers/evm-fixtures.ts";

type Fake = ReturnType<typeof createFakeEvmService>;
let fake: Fake | undefined;
const extraSpies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (extraSpies.length > 0) extraSpies.pop()!.mockRestore();
  fake?.restore();
  fake = undefined;
});

function setup(options: Parameters<typeof createFakeEvmService>[0] = {}): Fake {
  fake = createFakeEvmService(options);
  return fake;
}

function mockClient(target: object, method: string): Mock<(...args: any[]) => any> {
  const spy = spyOn(target as Record<string, (...args: any[]) => any>, method);
  extraSpies.push(spy);
  return spy;
}

async function creationIntent(
  fakeChain: Fake,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const wire = {
    creator: creatorAccount.address,
    token: TOKEN,
    gameType: 0,
    amount: "100",
    minPlayers: 2,
    maxPlayers: 2,
    timeout: 3600,
    isPrivate: false,
    nonce: "0",
    deadline: String(fakeChain.chain.now + 120n),
    ...overrides,
  };
  const proof = await creatorAccount.signTypedData(
    creationTypedData(fakeChain.service.config, {
      ...wire,
      amount: BigInt(wire.amount as string),
      nonce: BigInt(wire.nonce as string),
      deadline: BigInt(wire.deadline as string),
      commitment: zeroHash,
    } as never),
  );
  return { ...wire, proof };
}

describe("EvmService.validateDeployment", () => {
  test("accepts a proxy owned by the operator on the configured chain", async () => {
    const { service } = setup();

    await expect(service.validateDeployment()).resolves.toBeUndefined();
  });

  test("rejects an RPC endpoint on another chain", async () => {
    const { service, chain } = setup();
    chain.chainId = 1;

    await expect(service.validateDeployment()).rejects.toThrow("EVM RPC chain mismatch");
  });

  test("rejects a proxy owned by someone else", async () => {
    const { service, chain } = setup();
    chain.owner = creatorAccount.address;

    await expect(service.validateDeployment()).rejects.toThrow(
      "EVM operator does not own configured proxy",
    );
  });
});

describe("EvmService.authorize", () => {
  test("signs the creator's terms with a fresh commitment and stores the secret", async () => {
    const current = setup();
    const input = await creationIntent(current);

    const result = await current.service.authorize(input);

    const gameId = gameIdFor(current.service.config, creatorAccount.address, 0n);
    expect(result.gameId).toBe(gameId);
    const stored = current.store.game(gameId)!;
    const request = result.request as Record<string, string | number | boolean>;
    expect(request["commitment"]).toBe(commitmentFor(stored.secret));
    expect(request["amount"]).toBe("100");
    expect(stored.signature).toBe(result.signature);
    const signer = await recoverTypedDataAddress({
      ...creationTypedData(current.service.config, {
        ...(request as Record<string, unknown>),
        amount: 100n,
        nonce: 0n,
        deadline: BigInt(request["deadline"] as string),
      } as never),
      signature: result.signature,
    });
    expect(signer).toBe(operatorAccount.address);
    expect(current.client["verifyTypedData"]).toHaveBeenCalledWith(
      expect.objectContaining({ address: creatorAccount.address, signature: input["proof"] }),
    );
  });

  test("reuses the stored secret when the same nonce is authorized again", async () => {
    const current = setup();
    const first = await current.service.authorize(await creationIntent(current));
    const second = await current.service.authorize(
      await creationIntent(current, { amount: "150" }),
    );

    expect(second.gameId).toBe(first.gameId);
    expect((second.request as { commitment: Hex }).commitment).toBe(
      (first.request as { commitment: Hex }).commitment,
    );
    expect(JSON.parse(current.store.game(first.gameId)!.request).amount).toBe("150");
  });

  test("restarts when a concurrent authorization stored a different secret", async () => {
    const current = setup();
    const input = await creationIntent(current);
    const winner = `0x${"77".repeat(32)}` as Hex;
    const original = current.store.game.bind(current.store);
    let reads = 0;
    mockClient(current.store, "game").mockImplementation(((id: Hex) => {
      reads += 1;
      if (reads === 1) return null;
      return original(id) ?? { id, secret: winner, intent: "{}", request: "{}", signature: "0x" };
    }) as never);

    const result = await current.service.authorize(input);

    expect(reads).toBe(4);
    expect((result.request as { commitment: Hex }).commitment).toBe(commitmentFor(winner));
  });

  test("rejects deadlines outside the five-minute authorization window", async () => {
    const current = setup();

    await expect(
      current.service.authorize(
        await creationIntent(current, { deadline: String(current.chain.now + 301n) }),
      ),
    ).rejects.toThrow("Authorization expires within five minutes");
    await expect(
      current.service.authorize(
        await creationIntent(current, { deadline: String(current.chain.now) }),
      ),
    ).rejects.toThrow("Authorization expires within five minutes");
  });

  test("rejects timeouts and player counts beyond the oracle limits", async () => {
    const current = setup();

    await expect(
      current.service.authorize(await creationIntent(current, { maxPlayers: 11 })),
    ).rejects.toThrow("Game exceeds current oracle limits");
    current.chain.limits = [5, 600, 4000, 86_400, 10];
    await expect(current.service.authorize(await creationIntent(current))).rejects.toThrow(
      "Game exceeds current oracle limits",
    );
  });

  test("rejects amounts below the token minimum and impossible player bounds", async () => {
    const current = setup();

    await expect(
      current.service.authorize(await creationIntent(current, { amount: "99" })),
    ).rejects.toThrow("Invalid game terms");
    await expect(
      current.service.authorize(await creationIntent(current, { minPlayers: 1 })),
    ).rejects.toThrow("Invalid game terms");
    await expect(
      current.service.authorize(await creationIntent(current, { minPlayers: 3 })),
    ).rejects.toThrow("Invalid game terms");
  });

  test("rejects tokens without an oracle policy", async () => {
    const current = setup();

    await expect(
      current.service.authorize(
        await creationIntent(current, { token: "0x3333333333333333333333333333333333333333" }),
      ),
    ).rejects.toThrow("Unsupported EVM token");
  });

  test("rejects a proof not signed by the creator", async () => {
    const current = setup();
    current.chain.validSignature = false;

    await expect(current.service.authorize(await creationIntent(current))).rejects.toThrow(
      "Invalid creator proof",
    );
    expect(current.store.games()).toEqual([]);
  });

  test("rejects a stale creation nonce", async () => {
    const current = setup();
    current.chain.creationNonce = 1n;

    await expect(current.service.authorize(await creationIntent(current))).rejects.toThrow(
      "Creation nonce changed; reload wallet state",
    );
  });
});

describe("EvmService.privateJoin", () => {
  const gameId = `0x${"44".repeat(32)}` as Hex;

  async function invitation(current: Fake, deadline = current.chain.now + 60n) {
    const data = privateJoinTypedData(
      current.service.config,
      gameId,
      playerAccount.address,
      deadline,
    );
    return {
      gameId,
      player: playerAccount.address,
      deadline: String(deadline),
      proof: await creatorAccount.signTypedData(data),
    };
  }

  test("co-signs an invitation approved by the private game's creator", async () => {
    const current = setup();
    current.chain.games.set(gameId, fakeGame({ isPrivate: true }));
    const input = await invitation(current);

    const result = await current.service.privateJoin(input);

    expect(result.deadline).toBe(input.deadline);
    const signer = await recoverTypedDataAddress({
      ...privateJoinTypedData(
        current.service.config,
        gameId,
        playerAccount.address,
        BigInt(input.deadline),
      ),
      signature: result.signature,
    });
    expect(signer).toBe(operatorAccount.address);
    expect(current.client["verifyTypedData"]).toHaveBeenCalledWith(
      expect.objectContaining({ address: creatorAccount.address, signature: input.proof }),
    );
  });

  test("rejects invitations outside the five-minute window", async () => {
    const current = setup();
    current.chain.games.set(gameId, fakeGame({ isPrivate: true }));

    await expect(
      current.service.privateJoin(await invitation(current, current.chain.now + 301n)),
    ).rejects.toThrow("Invitation expires within five minutes");
  });

  test("rejects public or already settled games", async () => {
    const current = setup();
    current.chain.games.set(gameId, fakeGame({ isPrivate: false }));
    await expect(current.service.privateJoin(await invitation(current))).rejects.toThrow(
      "Private game unavailable",
    );

    current.chain.games.set(gameId, fakeGame({ isPrivate: true, status: 2 }));
    await expect(current.service.privateJoin(await invitation(current))).rejects.toThrow(
      "Private game unavailable",
    );
  });

  test("rejects invitations the creator did not sign", async () => {
    const current = setup();
    current.chain.games.set(gameId, fakeGame({ isPrivate: true }));
    current.chain.validSignature = false;

    await expect(current.service.privateJoin(await invitation(current))).rejects.toThrow(
      "Invalid invitation",
    );
  });
});

describe("EvmService.tick settlement", () => {
  const gameA = `0x${"a1".repeat(32)}` as Hex;
  const gameB = `0x${"b2".repeat(32)}` as Hex;
  const secretA = `0x${"c3".repeat(32)}` as Hex;
  const secretB = `0x${"d4".repeat(32)}` as Hex;

  function seed(current: Fake, id: Hex, secret: Hex, deadline = current.chain.now + 60n) {
    current.store.save({
      id,
      secret,
      intent: "{}",
      request: JSON.stringify({ deadline: deadline.toString() }),
      signature: "0x12",
    });
  }

  function stubSettlement(current: Fake) {
    mockClient(current.service, "index").mockResolvedValue(undefined);
    const simulate = mockClient(current.client, "simulateContract").mockImplementation(((call: {
      args: [Hex, Hex];
    }) =>
      Promise.resolve({ request: { functionName: "completeGame", args: call.args } })) as never);
    const estimate = mockClient(current.client, "estimateContractGas").mockResolvedValue(
      90_000n as never,
    );
    const prepare = mockClient(
      current.service.wallet,
      "prepareTransactionRequest",
    ).mockImplementation((async (request: { to: Hex; data: Hex; gas: bigint }) => ({
      ...request,
      chainId: 31337,
      nonce: 7,
      type: "eip1559",
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })) as never);
    // Sign with the operator's local key; the wallet action would otherwise ask the RPC for the chain id.
    mockClient(current.service.wallet, "signTransaction").mockImplementation(((
      transaction: Parameters<typeof operatorAccount.signTransaction>[0],
    ) => operatorAccount.signTransaction(transaction)) as never);
    const send = mockClient(current.client, "sendRawTransaction").mockImplementation((async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => keccak256(serializedTransaction)) as never);
    return { simulate, estimate, prepare, send };
  }

  test("submits one signed completion for a settleable game and journals it first", async () => {
    const current = setup();
    seed(current, gameA, secretA);
    current.chain.games.set(gameA, fakeGame());
    const { simulate, prepare, send } = stubSettlement(current);

    await current.service.tick();

    expect(simulate).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "completeGame", args: [gameA, secretA] }),
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        to: PROXY,
        data: completeGameTransaction(current.service.config, gameA, secretA).data,
        gas: 90_000n,
      }),
    );
    const pending = current.store.pending()!;
    expect(pending.game).toBe(gameA);
    expect(pending.hash).toBe(keccak256(pending.raw));
    expect(await recoverTransactionAddress({ serializedTransaction: pending.raw as never })).toBe(
      operatorAccount.address,
    );
    expect(send).toHaveBeenCalledWith({ serializedTransaction: pending.raw });
    expect(current.service.lastCycleFailed).toBe(false);
    expect(current.service.lastCycleAt).toBeGreaterThan(0);
  });

  test("skips reverted simulations so one bad game cannot starve the others", async () => {
    const current = setup();
    seed(current, gameA, secretA);
    seed(current, gameB, secretB);
    current.chain.games.set(gameA, fakeGame());
    current.chain.games.set(gameB, fakeGame());
    const { simulate } = stubSettlement(current);
    simulate.mockImplementationOnce(async () => {
      throw new ContractFunctionRevertedError({ abi: timbaAbi, functionName: "completeGame" });
    });

    await current.service.tick();

    expect(simulate).toHaveBeenCalledTimes(2);
    const settled = simulate.mock.calls[1]![0] as unknown as { args: [Hex, Hex] };
    expect(current.store.pending()?.game).toBe(settled.args[0]);
  });

  test("fails the cycle on unexpected settlement errors", async () => {
    const current = setup();
    seed(current, gameA, secretA);
    current.chain.games.set(gameA, fakeGame());
    const { simulate } = stubSettlement(current);
    simulate.mockRejectedValue(new Error("rpc offline"));

    await expect(current.service.tick()).rejects.toThrow("rpc offline");
    expect(current.service.lastCycleFailed).toBe(true);
    expect(current.store.pending()).toBeNull();
  });

  test("parks finished and never-created games for a day without settling them", async () => {
    const current = setup();
    seed(current, gameA, secretA);
    seed(current, gameB, secretB, current.chain.now - 400n);
    current.chain.games.set(gameA, fakeGame({ status: 2 }));
    current.chain.games.set(gameB, fakeGame({ status: 0 }));
    const { simulate } = stubSettlement(current);

    await current.service.tick();

    expect(simulate).not.toHaveBeenCalled();
    expect(current.store.games()).toEqual([]);
    const nextChecks = current.store.db
      .query<{ next_check: number }, []>("SELECT next_check FROM authorizations")
      .all()
      .map((row) => row.next_check - Date.now());
    for (const delay of nextChecks) expect(delay).toBeGreaterThan(86_000_000);
  });

  test("waits for games that cannot be settled yet", async () => {
    const current = setup();
    seed(current, gameA, secretA);
    current.chain.games.set(
      gameA,
      fakeGame({ participants: [creatorAccount.address], expiresAt: current.chain.now + 60n }),
    );
    const { simulate } = stubSettlement(current);

    await current.service.tick();

    expect(simulate).not.toHaveBeenCalled();
    expect(current.store.pending()).toBeNull();
  });

  test("ignores a tick while another cycle is still running", async () => {
    const current = setup();
    let release!: () => void;
    const validate = mockClient(current.service, "validateDeployment").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const index = mockClient(current.service, "index").mockResolvedValue(undefined);

    const first = current.service.tick();
    await current.service.tick();
    expect(validate).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(index).toHaveBeenCalledTimes(1);
  });
});

describe("EvmService.tick pending transaction", () => {
  const game = `0x${"e5".repeat(32)}` as Hex;
  const pending = { game, raw: "0xab" as Hex, hash: `0x${"f6".repeat(32)}` as Hex };

  function stubReceipt(current: Fake, receipt: unknown, head: bigint) {
    mockClient(current.service, "index").mockResolvedValue(undefined);
    const lookup = mockClient(current.client, "getTransactionReceipt").mockImplementation(
      (async () => {
        if (receipt instanceof Error) throw receipt;
        return receipt;
      }) as never,
    );
    mockClient(current.client, "getBlockNumber").mockResolvedValue(head as never);
    const send = mockClient(current.client, "sendRawTransaction").mockResolvedValue(
      pending.hash as never,
    );
    return { lookup, send };
  }

  test("clears the journal once the receipt has enough confirmations", async () => {
    const current = setup();
    current.store.submit(pending);
    const { lookup, send } = stubReceipt(current, { status: "success", blockNumber: 10n }, 11n);

    await current.service.tick();

    expect(lookup).toHaveBeenCalledWith({ hash: pending.hash });
    expect(current.store.pending()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test("clears the journal for a confirmed failed transaction", async () => {
    const current = setup();
    current.store.submit(pending);
    stubReceipt(current, { status: "reverted", blockNumber: 10n }, 12n);

    await current.service.tick();

    expect(current.store.pending()).toBeNull();
  });

  test("keeps the journal until the confirmation depth is reached", async () => {
    const current = setup();
    current.store.submit(pending);
    stubReceipt(current, { status: "success", blockNumber: 10n }, 10n);

    await current.service.tick();

    expect(current.store.pending()).toEqual(pending);
  });

  test("rebroadcasts the exact signed bytes when the receipt is missing", async () => {
    const current = setup();
    current.store.submit(pending);
    const { send } = stubReceipt(current, new TransactionReceiptNotFoundError({ hash: game }), 1n);

    await current.service.tick();

    expect(send).toHaveBeenCalledWith({ serializedTransaction: pending.raw });
    expect(current.store.pending()).toEqual(pending);
  });

  test("fails the cycle when the receipt lookup errors", async () => {
    const current = setup();
    current.store.submit(pending);
    stubReceipt(current, new Error("rpc offline"), 1n);

    await expect(current.service.tick()).rejects.toThrow("rpc offline");
    expect(current.service.lastCycleFailed).toBe(true);
    expect(current.store.pending()).toEqual(pending);
  });
});

describe("EvmService.index", () => {
  const gameId = `0x${"12".repeat(32)}` as Hex;
  const blockHash = (block: bigint) => `0x${block.toString(16).padStart(64, "0")}` as Hex;

  function joinedLog(block: bigint, address: Hex = PROXY) {
    return {
      address,
      blockHash: blockHash(block),
      blockNumber: block,
      transactionHash: `0x${"99".repeat(32)}` as Hex,
      logIndex: 0,
      removed: false,
      topics: encodeEventTopics({
        abi: timbaAbi,
        eventName: "PlayerJoined",
        args: { gameId, player: playerAccount.address },
      }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [0n, block]),
    };
  }

  function stubChain(current: Fake, head: bigint, logs: unknown[] = []) {
    mockClient(current.client, "getBlockNumber").mockResolvedValue(head as never);
    const getBlock = mockClient(current.client, "getBlock").mockImplementation((async ({
      blockNumber,
    }: {
      blockNumber: bigint;
    }) => ({ hash: blockHash(blockNumber), number: blockNumber })) as never);
    const getLogs = mockClient(current.client, "getLogs").mockResolvedValue(logs as never);
    return { getBlock, getLogs };
  }

  test("does nothing before the chain reaches the confirmation depth", async () => {
    const current = setup();
    const { getLogs } = stubChain(current, 1n);

    await current.service.index();

    expect(getLogs).not.toHaveBeenCalled();
    expect(current.store.cursor()).toBeNull();
  });

  test("stores decoded deployment events and advances the cursor", async () => {
    const current = setup();
    const foreign = joinedLog(3n, "0x4444444444444444444444444444444444444444");
    const { getLogs } = stubChain(current, 10n, [joinedLog(3n), foreign]);

    await current.service.index();

    expect(getLogs).toHaveBeenCalledWith({ address: PROXY, fromBlock: 0n, toBlock: 9n });
    expect(current.store.cursor()).toEqual({ block: 9, hash: blockHash(9n) });
    const events = current.store.events(gameId) as Array<{ event: { kind: string } }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toMatchObject({ kind: "joined", player: playerAccount.address });
  });

  test("scans at most 500 blocks per cycle and resumes from the cursor", async () => {
    const current = setup();
    const { getLogs } = stubChain(current, 2_000n);

    await current.service.index();
    await current.service.index();

    expect(
      getLogs.mock.calls.map(
        (call) => (call as unknown as [{ fromBlock: bigint; toBlock: bigint }])[0],
      ),
    ).toEqual([
      expect.objectContaining({ fromBlock: 0n, toBlock: 499n }),
      expect.objectContaining({ fromBlock: 500n, toBlock: 999n }),
    ]);
  });

  test("stops when the cursor is already at the confirmed head", async () => {
    const current = setup();
    const { getLogs } = stubChain(current, 10n);
    await current.service.index();

    await current.service.index();

    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  test("resets the index after a confirmed-chain reorganization", async () => {
    const current = setup();
    const { getBlock } = stubChain(current, 10n, [joinedLog(3n)]);
    await current.service.index();
    getBlock.mockImplementation((async () => ({ hash: `0x${"ee".repeat(32)}` })) as never);

    await current.service.index();

    expect(current.store.cursor()).toBeNull();
    expect(current.store.events()).toEqual([]);
  });

  test("discards a batch whose end block changed while logs were read", async () => {
    const current = setup();
    const { getBlock } = stubChain(current, 10n, [joinedLog(3n)]);
    let reads = 0;
    getBlock.mockImplementation((async ({ blockNumber }: { blockNumber: bigint }) => {
      reads += 1;
      return { hash: reads === 1 ? blockHash(blockNumber) : `0x${"ee".repeat(32)}` };
    }) as never);

    await current.service.index();

    expect(current.store.cursor()).toBeNull();
    expect(current.store.events()).toEqual([]);
  });
});
