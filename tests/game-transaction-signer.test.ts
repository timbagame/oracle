import { describe, expect, test } from "bun:test";
import {
  AccountRole,
  address,
  compileTransaction,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  decompileTransactionMessage,
  partiallySignTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import {
  GameType,
  getInitializeGameInstructionDataEncoder,
  getJoinGameInstructionDataEncoder,
} from "@timbagame/protocol/contracts/v0.3.0/kit";
import { getContractIdl } from "../contract-idl.ts";
import {
  signGameTransactionWithPolicy,
  TransactionPolicyError,
  type SignGameTransactionOptions,
} from "../game-transaction-signer.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "../token-program.ts";

const PROGRAM_ID = address(getContractIdl("0.3.0").address);
const COMPUTE_BUDGET_PROGRAM_ID = address("ComputeBudget111111111111111111111111111111");
const BLOCKHASH = "11111111111111111111111111111111";

type Scenario = {
  creator: KeyPairSigner;
  operator: KeyPairSigner;
  game: Address;
  tokenMint: Address;
  randomHash: Uint8Array;
  initialize: Instruction;
  join: Instruction;
  calls: {
    policy: Array<[Address, bigint]>;
    unused: Array<[Address, string]>;
    signed: Address[];
  };
  options: SignGameTransactionOptions;
};

async function randomAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

async function createScenario(
  overrides: { isPrivate?: boolean; operatorPlaceholder?: boolean } = {},
): Promise<Scenario> {
  const creator = await generateKeyPairSigner();
  const operator = await generateKeyPairSigner();
  const game = await randomAddress();
  const tokenMint = await randomAddress();
  const randomHash = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const client = getContractClient("0.3.0");
  const [oracle] = await client.findOraclePda({ programAddress: PROGRAM_ID });
  const [gameVault] = await client.findGameVaultPda({ tokenMint }, { programAddress: PROGRAM_ID });
  const vaultAta = await deriveAssociatedTokenAddress(tokenMint, gameVault, true);
  const creatorAta = await deriveAssociatedTokenAddress(tokenMint, creator.address);
  const operatorMeta = overrides.operatorPlaceholder ? await randomAddress() : operator.address;

  const initialize: Instruction = {
    programAddress: PROGRAM_ID,
    data: getInitializeGameInstructionDataEncoder().encode({
      gameType: GameType.Coinflip,
      amount: 250n,
      maxTickets: 2,
      minTickets: 2,
      timeout: 60n,
      isPrivate: overrides.isPrivate ?? false,
      randomHash,
    }),
    accounts: [
      { address: game, role: AccountRole.WRITABLE },
      { address: creator.address, role: AccountRole.WRITABLE_SIGNER },
      { address: oracle, role: AccountRole.READONLY },
      { address: operatorMeta, role: AccountRole.READONLY_SIGNER },
      { address: tokenMint, role: AccountRole.READONLY },
      { address: gameVault, role: AccountRole.READONLY },
      { address: vaultAta, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: creatorAta, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
  const join: Instruction = {
    programAddress: PROGRAM_ID,
    data: getJoinGameInstructionDataEncoder().encode({}),
    accounts: [
      { address: game, role: AccountRole.WRITABLE },
      { address: creator.address, role: AccountRole.WRITABLE_SIGNER },
      overrides.isPrivate
        ? { address: operator.address, role: AccountRole.READONLY_SIGNER }
        : { address: PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenMint, role: AccountRole.READONLY },
      { address: gameVault, role: AccountRole.READONLY },
      { address: vaultAta, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: creatorAta, role: AccountRole.WRITABLE },
      { address: oracle, role: AccountRole.READONLY },
    ],
  };

  const calls: Scenario["calls"] = { policy: [], unused: [], signed: [] };
  return {
    creator,
    operator,
    game,
    tokenMint,
    randomHash,
    initialize,
    join,
    calls,
    options: {
      contractVersion: "0.3.0",
      programId: PROGRAM_ID,
      operator,
      getGamePda: async () => game,
      assertCreationPolicy: async (mint, amount) => {
        calls.policy.push([mint, amount]);
      },
      assertUnusedCommitment: (gameAddress, hash) => {
        calls.unused.push([gameAddress, hash]);
      },
      markCommitmentSigned: (gameAddress) => {
        calls.signed.push(gameAddress);
      },
    },
  };
}

function compile(
  scenario: Scenario,
  instructions: Instruction[],
  version: "legacy" | 0 = "legacy",
): Transaction {
  return compileTransaction({
    version,
    feePayer: { address: scenario.creator.address },
    lifetimeConstraint: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
    instructions,
  } as never);
}

async function encode(
  scenario: Scenario,
  instructions: Instruction[],
  options: { version?: "legacy" | 0; signByCreator?: boolean } = {},
): Promise<string> {
  let transaction = compile(scenario, instructions, options.version);
  if (options.signByCreator) {
    transaction = await partiallySignTransaction([scenario.creator.keyPair], transaction);
  }
  return getBase64EncodedWireTransaction(transaction);
}

function decode(base64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
  );
  return { transaction, message };
}

async function policyError(base64: string, options: SignGameTransactionOptions): Promise<Error> {
  try {
    await signGameTransactionWithPolicy(base64, options);
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionPolicyError);
    return error as Error;
  }
  throw new Error("Expected the transaction to be rejected");
}

describe("signGameTransactionWithPolicy", () => {
  test("signs a creator-signed atomic join and records the commitment around signing", async () => {
    const scenario = await createScenario({ isPrivate: true });
    const payload = await encode(scenario, [scenario.initialize, scenario.join], {
      signByCreator: true,
    });

    const signed = decode(await signGameTransactionWithPolicy(payload, scenario.options));

    expect(signed.transaction.signatures[scenario.operator.address]).toBeInstanceOf(Uint8Array);
    expect(signed.transaction.signatures[scenario.creator.address]).toEqual(
      decode(payload).transaction.signatures[scenario.creator.address]!,
    );
    expect(scenario.calls.policy).toEqual([[scenario.tokenMint, 250n]]);
    expect(scenario.calls.unused).toEqual([
      [scenario.game, Buffer.from(scenario.randomHash).toString("hex")],
    ]);
    expect(scenario.calls.signed).toEqual([scenario.game, scenario.game]);
  });

  test("replaces an operator placeholder before signing", async () => {
    const scenario = await createScenario({ operatorPlaceholder: true });
    const payload = await encode(scenario, [scenario.initialize]);

    const signed = decode(await signGameTransactionWithPolicy(payload, scenario.options));

    const accounts = (signed.message.instructions[0] as Instruction).accounts!;
    expect(accounts[3]!.address).toBe(scenario.operator.address);
    expect(signed.transaction.signatures[scenario.operator.address]).toBeInstanceOf(Uint8Array);
  });

  test("rejects payloads that are not a decodable transaction", async () => {
    const scenario = await createScenario();

    const error = await policyError("not-a-transaction", scenario.options);

    expect(error.message).toBe("Invalid transaction payload");
    expect(error.cause).toBeDefined();
  });

  test("rejects versioned transactions", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [scenario.initialize], { version: 0 });

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Only legacy game transactions are supported",
    );
  });

  test("rejects transactions without a game instruction", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [
      { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: new Uint8Array([3]) },
    ]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Transaction must contain initialization and an optional creator join",
    );
  });

  test("rejects an initialization with the wrong number of accounts", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [
      { ...scenario.initialize, accounts: scenario.initialize.accounts!.slice(0, 10) },
    ]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Invalid initialize-game account list",
    );
  });

  test("rejects an initialization with a foreign discriminator", async () => {
    const scenario = await createScenario();
    const data = Uint8Array.from(scenario.initialize.data!);
    data[0] = data[0]! ^ 0xff;
    const payload = await encode(scenario, [{ ...scenario.initialize, data }]);

    const error = await policyError(payload, scenario.options);

    expect(error.message).toBe("Invalid game instruction data");
    expect((error.cause as Error).message).toBe("Unexpected instruction discriminator");
  });

  test("rejects a writable oracle operator account", async () => {
    const scenario = await createScenario();
    const accounts = [...scenario.initialize.accounts!];
    accounts[3] = { address: scenario.operator.address, role: AccountRole.WRITABLE_SIGNER };
    const payload = await encode(scenario, [{ ...scenario.initialize, accounts }]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Invalid oracle operator account",
    );
  });

  test("rejects a game account that does not match the random hash commitment", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [scenario.initialize]);
    const otherGame = await randomAddress();

    const error = await policyError(payload, {
      ...scenario.options,
      getGamePda: async () => otherGame,
    });

    expect(error.message).toBe("Game account does not match the committed random hash");
    expect(scenario.calls.unused).toEqual([]);
  });

  test("rejects an atomic join before the creator has placed the operator", async () => {
    const scenario = await createScenario({ operatorPlaceholder: true });
    const payload = await encode(scenario, [scenario.initialize, scenario.join]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Atomic creator join requires the creator to sign first",
    );
  });

  test("rejects a join with the wrong number of accounts", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [
      scenario.initialize,
      { ...scenario.join, accounts: scenario.join.accounts!.slice(0, 9) },
    ]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Invalid creator join instruction",
    );
  });

  test("rejects a join with a foreign discriminator", async () => {
    const scenario = await createScenario();
    const data = Uint8Array.from(scenario.join.data!);
    data[0] = data[0]! ^ 0xff;
    const payload = await encode(scenario, [scenario.initialize, { ...scenario.join, data }]);

    const error = await policyError(payload, scenario.options);

    expect(error.message).toBe("Invalid creator join instruction");
    expect((error.cause as Error).message).toBe("Unexpected instruction discriminator");
  });

  test("rejects setup instructions from programs outside the allow-list", async () => {
    const scenario = await createScenario();
    const foreign = await randomAddress();
    const payload = await encode(scenario, [
      { programAddress: foreign, data: new Uint8Array([1]) },
      scenario.initialize,
    ]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      `Unsupported setup instruction in game transaction: ${foreign}`,
    );
    expect(scenario.calls.signed).toEqual([]);
  });

  test("rejects setup instructions that reference the oracle operator", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM_ID,
        data: new Uint8Array([3]),
        accounts: [{ address: scenario.operator.address, role: AccountRole.READONLY }],
      },
      scenario.initialize,
    ]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Oracle operator cannot be referenced by setup instructions",
    );
  });

  test("rejects a creator-placed operator without the creator signature", async () => {
    const scenario = await createScenario();
    const payload = await encode(scenario, [scenario.initialize]);

    expect((await policyError(payload, scenario.options)).message).toBe(
      "Creator signature is missing or invalid",
    );
    expect(scenario.calls.policy).toEqual([]);
    expect(scenario.calls.signed).toEqual([]);
  });
});
