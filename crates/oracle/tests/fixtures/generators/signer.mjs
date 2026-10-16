import {
  AccountRole, address, compileTransaction, createKeyPairSignerFromPrivateKeyBytes,
  getBase64EncodedWireTransaction, partiallySignTransaction, getAddressEncoder,
  getProgramDerivedAddress, appendTransactionMessageInstructions, createTransactionMessage,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import * as v3 from "@timbagame/protocol/contracts/v0.3.0/kit";
import * as v2 from "@timbagame/protocol/contracts/v0.2.0/kit";
import { getContractIdl } from "@timbagame/protocol/contracts/idl";
import { signGameTransactionWithPolicy, TransactionPolicyError } from "./src/game-transaction-signer.ts";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, deriveAssociatedTokenAddress } from "./src/token-program.ts";

const PROGRAM_ID = address(getContractIdl("0.3.0").address);
const COMPUTE = address("ComputeBudget111111111111111111111111111111");
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const seed = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255);
async function signer(n) {
  const s = await createKeyPairSignerFromPrivateKeyBytes(seed(n), true);
  return s;
}
const enc = getAddressEncoder();
const hex = (b) => Buffer.from(b).toString("hex");

async function scenario(version, { isPrivate = false, placeholder = false, creatorOffCurve = false } = {}) {
  const creator = await signer(1);
  const operator = await signer(2);
  const placeholderSigner = await signer(3);
  const tokenMint = (await signer(4)).address;
  const randomHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const client = getContractClient(version);
  const config = { programAddress: PROGRAM_ID };
  const [game] = await client.findGamePda({ randomHash }, config);
  const [oracle] = await client.findOraclePda(config);
  const [gameVault] = await client.findGameVaultPda({ tokenMint }, config);
  const [gameToken] = await v2.findGameTokenPda({ tokenMint }, config);
  const creatorAddress = creatorOffCurve ? (await v2.findGameTokenPda({ tokenMint: (await signer(9)).address }, config))[0] : creator.address;
  const vaultAta = await deriveAssociatedTokenAddress(tokenMint, gameVault, true);
  const creatorAta = await deriveAssociatedTokenAddress(tokenMint, creatorAddress, true);
  const operatorMeta = placeholder ? placeholderSigner.address : operator.address;
  const k = version === "0.2.0" ? v2 : v3;
  const legacy = version === "0.2.0";
  const initialize = {
    programAddress: PROGRAM_ID,
    data: k.getInitializeGameInstructionDataEncoder().encode({
      gameType: k.GameType.Coinflip, amount: 250n, maxTickets: 2, minTickets: 2, timeout: 60n, isPrivate, randomHash,
    }),
    accounts: [
      { address: game, role: AccountRole.WRITABLE },
      { address: creatorAddress, role: AccountRole.WRITABLE_SIGNER },
      { address: oracle, role: AccountRole.READONLY },
      { address: operatorMeta, role: AccountRole.READONLY_SIGNER },
      { address: tokenMint, role: AccountRole.READONLY },
      ...(legacy ? [{ address: gameToken, role: AccountRole.WRITABLE }] : []),
      { address: gameVault, role: AccountRole.READONLY },
      { address: vaultAta, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: creatorAta, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
  const join = {
    programAddress: PROGRAM_ID,
    data: k.getJoinGameInstructionDataEncoder().encode({}),
    accounts: [
      { address: game, role: AccountRole.WRITABLE },
      { address: creatorAddress, role: AccountRole.WRITABLE_SIGNER },
      isPrivate ? { address: operator.address, role: AccountRole.READONLY_SIGNER } : { address: PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenMint, role: AccountRole.READONLY },
      ...(legacy ? [{ address: gameToken, role: AccountRole.WRITABLE }] : []),
      { address: gameVault, role: AccountRole.READONLY },
      { address: vaultAta, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: creatorAta, role: AccountRole.WRITABLE },
      { address: oracle, role: AccountRole.READONLY },
    ],
  };
  return { creator, operator, creatorAddress, game, initialize, join, tokenMint, version };
}

function build(s, instructions, { sign = true, feePayer, version = "legacy" } = {}) {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(feePayer ?? s.creatorAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 10n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return compileTransaction(message);
}

async function finish(s, tx, sign) {
  const signed = sign ? await partiallySignTransaction([s.creator.keyPair], tx) : tx;
  return getBase64EncodedWireTransaction(signed);
}

const setupAta = (s) => ({
  programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
  data: new Uint8Array([1]),
  accounts: [
    { address: s.creatorAddress, role: AccountRole.WRITABLE_SIGNER },
    { address: s.initialize.accounts.at(-2).address, role: AccountRole.WRITABLE },
    { address: s.creatorAddress, role: AccountRole.READONLY },
    { address: s.tokenMint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
  ],
});
const compute = { programAddress: COMPUTE, data: new Uint8Array([2, 64, 66, 15, 0]) };

const cases = [];
async function add(name, version, txBase64Promise) {
  const txBase64 = await txBase64Promise;
  const operator = await signer(2);
  const marks = [];
  const unused = [];
  const policy = [];
  let expected;
  try {
    const out = await signGameTransactionWithPolicy(txBase64, {
      contractVersion: version,
      programId: PROGRAM_ID,
      operator,
      getGamePda: async (randomHash) => (await getContractClient(version).findGamePda({ randomHash }, { programAddress: PROGRAM_ID }))[0],
      assertCreationPolicy: async (mint, amount) => { policy.push([mint, amount.toString()]); },
      assertUnusedCommitment: (game, h) => { unused.push([game, h]); },
      markCommitmentSigned: (game) => { marks.push(game); },
    });
    expected = { ok: out };
  } catch (error) {
    expected = { error: error.message, policy: error instanceof TransactionPolicyError };
  }
  cases.push({ name, version, txBase64, expected, marks, unused, policy });
}

for (const version of ["0.3.0", "0.2.0"]) {
  let s = await scenario(version);
  await add(`${version} creator-signed join`, version, finish(s, build(s, [compute, setupAta(s), s.initialize, s.join]), true));
  s = await scenario(version, { placeholder: true });
  await add(`${version} placeholder`, version, finish(s, build(s, [compute, setupAta(s), s.initialize]), false));
  await add(`${version} placeholder join`, version, finish(s, build(s, [s.initialize, s.join]), false));
  s = await scenario(version, { isPrivate: true });
  await add(`${version} private join`, version, finish(s, build(s, [s.initialize, s.join]), true));
}
let s = await scenario("0.3.0");
await add("missing creator signature", "0.3.0", finish(s, build(s, [s.initialize]), false));
await add("foreign setup program", "0.3.0", finish(s, build(s, [{ programAddress: address("Stake11111111111111111111111111111111111111"), data: new Uint8Array([1]) }, s.initialize]), true));
// A writable reference merges into the operator's initialize meta and fails that check first.
await add("setup marks operator writable", "0.3.0", finish(s, build(s, [{ programAddress: SYSTEM_PROGRAM_ADDRESS, data: new Uint8Array([2,0,0,0,1,0,0,0,0,0,0,0]), accounts: [{ address: s.creatorAddress, role: AccountRole.WRITABLE_SIGNER }, { address: s.operator.address, role: AccountRole.WRITABLE }] }, s.initialize]), true));
await add("setup references operator", "0.3.0", finish(s, build(s, [{ programAddress: SYSTEM_PROGRAM_ADDRESS, data: new Uint8Array([2,0,0,0,1,0,0,0,0,0,0,0]), accounts: [{ address: s.creatorAddress, role: AccountRole.WRITABLE_SIGNER }, { address: s.operator.address, role: AccountRole.READONLY }] }, s.initialize]), true));
await add("durable nonce", "0.3.0", finish(s, build(s, [{ programAddress: SYSTEM_PROGRAM_ADDRESS, data: new Uint8Array([4,0,0,0]), accounts: [{ address: s.creatorAddress, role: AccountRole.WRITABLE_SIGNER }] }, s.initialize]), true));
await add("no game instruction", "0.3.0", finish(s, build(s, [compute]), true));
await add("three game instructions", "0.3.0", finish(s, build(s, [s.initialize, s.join, s.join]), true));
await add("wrong account count", "0.3.0", finish(s, build(s, [{ ...s.initialize, accounts: s.initialize.accounts.slice(0, 10) }]), true));
await add("foreign discriminator", "0.3.0", finish(s, build(s, [{ ...s.initialize, data: new Uint8Array([...s.join.data, ...s.initialize.data.slice(8)]) }]), true));
await add("short data", "0.3.0", finish(s, build(s, [{ ...s.initialize, data: s.initialize.data.slice(0, 20) }]), true));
await add("writable operator", "0.3.0", finish(s, build(s, [{ ...s.initialize, accounts: s.initialize.accounts.map((m, i) => i === 3 ? { ...m, role: AccountRole.WRITABLE_SIGNER } : m) }]), true));
await add("wrong vault", "0.3.0", finish(s, build(s, [{ ...s.initialize, accounts: s.initialize.accounts.map((m, i) => i === 5 ? { ...m, address: s.tokenMint } : m) }]), true));
await add("version mismatch", "0.2.0", finish(s, build(s, [s.initialize]), true));
await add("bad join count", "0.3.0", finish(s, build(s, [s.initialize, { ...s.join, accounts: s.join.accounts.slice(0, 9) }]), true));
await add("join wrong mint", "0.3.0", finish(s, build(s, [s.initialize, { ...s.join, accounts: s.join.accounts.map((m, i) => i === 3 ? { ...m, address: s.game } : m) }]), true));
await add("fee payer differs", "0.3.0", finish(s, build(s, [s.initialize], { feePayer: s.operator.address }), false));
// Every account the signer pins, swapped for an unrelated address.
const swap = (ix, index, address) => ({ ...ix, accounts: ix.accounts.map((m, i) => (i === index ? { ...m, address } : m)) });
const stranger = (await signer(20)).address;
for (const [index, label] of [[0, "game"], [2, "oracle"], [6, "vault token account"], [7, "token program"], [8, "associated token program"], [9, "creator token account"], [10, "system program"]]) {
  await add(`initialize with wrong ${label}`, "0.3.0", finish(s, build(s, [swap(s.initialize, index, stranger)]), true));
}
for (let index = 0; index < 10; index++) {
  await add(`join with wrong account ${index}`, "0.3.0", finish(s, build(s, [s.initialize, swap(s.join, index, stranger)]), true));
}
await add("join foreign discriminator", "0.3.0", finish(s, build(s, [s.initialize, { ...s.join, data: s.initialize.data.slice(0, 8) }]), true));
await add("versioned transaction", "0.3.0", finish(s, build(s, [s.initialize], { version: 0 }), true));
const legacy = await scenario("0.2.0");
await add("0.2.0 initialize with wrong game token", "0.2.0", finish(legacy, build(legacy, [swap(legacy.initialize, 5, stranger)]), true));
await add("0.2.0 join with wrong game token", "0.2.0", finish(legacy, build(legacy, [legacy.initialize, swap(legacy.join, 4, stranger)]), true));
s = await scenario("0.3.0", { creatorOffCurve: true, placeholder: true });
await add("creator off curve", "0.3.0", finish(s, build(s, [s.initialize]), false));
cases.push({ name: "invalid base64", version: "0.3.0", txBase64: "!!!", expected: { error: "Invalid transaction payload", policy: true }, marks: [], unused: [], policy: [] });
const opSeed = seed(2);
const opPub = enc.encode((await signer(2)).address);
console.log(JSON.stringify({ operatorKeypair: [...opSeed, ...opPub], cases }, null, 1));
