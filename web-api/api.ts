import { createHash } from "node:crypto";
import {
  getBase64EncodedWireTransaction,
  address,
  assertIsFullySignedTransaction,
  fetchEncodedAccount,
  type Instruction,
} from "@solana/kit";
import { TokenPoliciesResponseSchema } from "@timbagame/protocol/oracle";
import {
  CreateGameRequestSchema,
  PrepareGameResponseSchema,
  SubmitGameRequestSchema,
  SubmitGameResponseSchema,
} from "@timbagame/protocol/web";
import type { OracleService } from "../oracle-service.ts";
import type { IndexerDatabase } from "../indexer/database.ts";
import { getConfig } from "../config.ts";
import { getTokenUsdPrices } from "../indexer/pricing.ts";
import { CreateGameValidationError, validateCreateGameRequest } from "./create-game-request.ts";
import { buildCreateGamePlan } from "./create-game.ts";
import { createContractAdapter } from "./contract-adapter.ts";
import { contractCapabilities, contractVersion } from "./contract-version.ts";
import {
  assertGameTokenAmount,
  assertGameTokenPolicy,
  getGameTokenMetadata,
  getGameTokenConfigs,
  formatGameTokenPolicies,
} from "./game-token-config.ts";
import {
  createLegacyTransaction,
  decodeTransactionBase64,
  encodeTransactionBase64,
} from "./transaction.ts";
import { serializeGame } from "./serialized-game.ts";
import { createVerificationLoader } from "./cache.ts";
import { isValidSignature, verifyGameTransaction } from "./verification.ts";

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new CreateGameValidationError("Expected JSON");
  const reader = request.body?.getReader();
  if (!reader) throw new CreateGameValidationError("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CreateGameValidationError("Request is too large");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new CreateGameValidationError("Invalid JSON");
    }
  } finally {
    reader.releaseLock();
  }
}

export function createWebGameApi(
  oracle: Pick<
    OracleService,
    | "getConnection"
    | "getProgramId"
    | "getTokenPolicies"
    | "generateGameSecrets"
    | "signGameTransaction"
  >,
  database: Pick<IndexerDatabase, "getVerifiedGame" | "saveVerifiedGame">,
) {
  const adapter = createContractAdapter();
  const verify = createVerificationLoader({
    read: (key) => database.getVerifiedGame(key),
    write: (key, value) => database.saveVerifiedGame(key, value),
    load: (value) => verifyGameTransaction(oracle.getConnection(), oracle.getProgramId(), value),
    namespace: `${createHash("sha256")
      .update(process.env["SOLANA_NETWORK"] ?? "configured")
      .digest("hex")}:${oracle.getProgramId()}`,
  });
  let tokenCache: { value: unknown; expires: number } | undefined;
  let tokenPending: Promise<unknown> | undefined;
  async function tokenConfig() {
    if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.value;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      const rpc = oracle.getConnection();
      const policies = contractCapabilities.gameTokenAccount
        ? null
        : TokenPoliciesResponseSchema.shape.policies.parse(await oracle.getTokenPolicies());
      const configs = policies
        ? formatGameTokenPolicies(
            policies,
            new Map(),
            await getGameTokenMetadata(
              rpc,
              policies.map((p) => address(p.mint)),
            ),
          )
        : await getGameTokenConfigs(rpc);
      const prices = await getTokenUsdPrices(
        configs.map((c) => c.mint),
        getConfig().jupiterApiKey,
      ).catch(() => new Map<string, number>());
      const value = {
        tokens: configs.map((c) => ({ ...c, priceUsd: prices.get(c.mint) ?? null })),
      };
      tokenCache = { value, expires: Date.now() + 5000 };
      return value;
    })();
    try {
      return await tokenPending;
    } finally {
      tokenPending = undefined;
    }
  }
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (value: unknown, cache = "no-store") =>
      Response.json(value, { headers: { "cache-control": cache } });
    try {
      if (path === "/web/config" && request.method === "GET")
        return json(await tokenConfig(), "public, max-age=5, s-maxage=10");
      const verification = path.match(/^\/web\/verification\/([^/]+)$/);
      if (verification && request.method === "GET") {
        if (!isValidSignature(verification[1]!))
          return Response.json({ error: "Invalid signature" }, { status: 400 });
        return json(
          await verify(verification[1]!),
          "public, max-age=31536000, s-maxage=31536000, immutable",
        );
      }
      if (path === "/web/games/prepare" && request.method === "POST") {
        const parsed = CreateGameRequestSchema.safeParse(await readBody(request, 4096));
        if (!parsed.success) throw new CreateGameValidationError("Invalid game request");
        // Prevent a web build targeting a different contract generation from receiving incompatible bytes.
        if (request.headers.get("x-timba-contract-version") !== contractVersion)
          throw new CreateGameValidationError("Game contract configuration mismatch");
        const input = validateCreateGameRequest(parsed.data);
        const rpc = oracle.getConnection();
        if (contractCapabilities.gameTokenAccount)
          await assertGameTokenAmount(rpc, input.tokenMint, input.amount);
        else
          assertGameTokenPolicy(
            TokenPoliciesResponseSchema.shape.policies.parse(await oracle.getTokenPolicies()),
            input.tokenMint,
            input.amount,
            await getGameTokenMetadata(rpc, [input.tokenMint]),
          );
        const commitment = await oracle.generateGameSecrets({ gameType: input.type });
        const plan = await buildCreateGamePlan({
          ...input,
          timeoutSeconds: BigInt(input.timeoutSeconds),
          randomHash: Buffer.from(commitment.randomHash, "hex"),
          oracleOperator: address(
            commitment.oracleOperator ??
              (() => {
                throw new Error("Missing oracle operator");
              })(),
          ),
        });
        const instructions: Instruction[] = [...plan.instructions];
        if (input.type === "coinflip")
          instructions.push(
            ...(
              await adapter.buildJoinPlan({
                game: plan.game,
                player: input.creator,
                tokenMint: input.tokenMint,
                tokenAmount: input.amount,
              })
            ).instructions.slice(1),
          );
        const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
        return json(
          PrepareGameResponseSchema.parse({
            txBase64: encodeTransactionBase64(
              createLegacyTransaction(input.creator, latest.value, instructions),
            ),
            gameAddress: plan.game,
            lastValidBlockHeight: Number(latest.value.lastValidBlockHeight),
          }),
        );
      }
      if (path === "/web/games/submit" && request.method === "POST") {
        const parsed = SubmitGameRequestSchema.safeParse(await readBody(request, 8192));
        if (!parsed.success) throw new CreateGameValidationError("Invalid transaction");
        // Existing oracle validation checks instructions, creator signature, commitment and token policy.
        const signed = await oracle.signGameTransaction(parsed.data.txBase64);
        const transaction = decodeTransactionBase64(signed);
        assertIsFullySignedTransaction(transaction);
        const signature = await oracle
          .getConnection()
          .sendTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: "base64",
            preflightCommitment: "confirmed",
          })
          .send();
        return json(SubmitGameResponseSchema.parse({ signature }));
      }
      const game = path.match(/^\/web\/games\/([^/]+)$/);
      if (game && request.method === "GET") {
        let gameAddress;
        try {
          gameAddress = address(game[1]!);
        } catch {
          throw new CreateGameValidationError("Invalid game address");
        }
        const account = await fetchEncodedAccount(oracle.getConnection(), gameAddress, {
          commitment: "confirmed",
        });
        if (!account.exists) return Response.json({ error: "Game not found" }, { status: 404 });
        if (account.programAddress !== oracle.getProgramId())
          throw new CreateGameValidationError("Invalid game account");
        return json(
          serializeGame(adapter.decodeGame(gameAddress, account.data)),
          url.searchParams.get("fresh") === "1" ? "no-store" : "public, max-age=2, s-maxage=2",
        );
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof CreateGameValidationError
              ? error.publicMessage
              : "Game service temporarily unavailable",
        },
        {
          status: error instanceof CreateGameValidationError ? 400 : 503,
          headers: { "cache-control": "no-store", "retry-after": "5" },
        },
      );
    }
  };
  return Object.assign(handle, { verify });
}
