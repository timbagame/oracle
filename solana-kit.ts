import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getBase58Decoder,
  parseBase64RpcAccount,
  signature,
  type Address,
  type Base64EncodedBytes,
  type Blockhash,
  type EncodedAccount,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
  signatureBytes,
} from "@solana/kit";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytesSync,
} from "node:crypto";
import type { PublicKeyLike } from "./solana-utils.ts";

export type OracleRpc = ReturnType<typeof createSolanaRpc>;
export type OracleRpcSubscriptions = ReturnType<typeof createSolanaRpcSubscriptions>;
export type LatestBlockhash = Readonly<{
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}>;

export function createRpc(endpoint: string): OracleRpc {
  return createSolanaRpc(endpoint as `${string}://${string}`);
}

export function createRpcSubscriptions(endpoint: string): OracleRpcSubscriptions {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return createSolanaRpcSubscriptions(url.toString() as `${"ws" | "wss"}://${string}`);
}

export async function createSigner(secretKey: Uint8Array): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(secretKey);
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function pow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = mod(base, modulus);
  for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
    if (remaining & 1n) result = mod(result * value, modulus);
    value = mod(value * value, modulus);
  }
  return result;
}

function compressedPointIsOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const p = (1n << 255n) - 19n;
  const d = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
  const encoded = Uint8Array.from(bytes);
  const signBit = encoded[31]! >> 7;
  encoded[31] = encoded[31]! & 0x7f;
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) y = (y << 8n) | BigInt(encoded[index]!);
  if (y >= p) return false;
  const ySquared = mod(y * y, p);
  const xSquared = mod((ySquared - 1n) * pow(d * ySquared + 1n, p - 2n, p), p);
  let x = pow(xSquared, (p + 3n) / 8n, p);
  if (mod(x * x - xSquared, p) !== 0n) x = mod(x * pow(2n, (p - 1n) / 4n, p), p);
  if (mod(x * x - xSquared, p) !== 0n) return false;
  if (Number(x & 1n) !== signBit) x = p - x;
  return !(x === 0n && signBit === 1);
}

export function addressIsOnCurve(value: Address): boolean {
  return compressedPointIsOnCurve(Uint8Array.from(addressBytes(value)));
}

export function createSyncSigner(secretKey: Uint8Array): KeyPairSigner {
  if (secretKey.length !== 64) throw new Error("Solana keypair must contain 64 bytes");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  if (!Buffer.from(publicBytes).equals(Buffer.from(secretKey.subarray(32)))) {
    throw new Error("Solana keypair public key does not match its secret seed");
  }
  const signerAddress = addressFromBytes(publicBytes);
  const signContent = (content: ReadonlyUint8Array) =>
    signatureBytes(signBytesSync(null, Buffer.from(content), privateKey));
  return Object.freeze({
    address: signerAddress,
    keyPair: {} as CryptoKeyPair,
    signMessages: async (messages: readonly { content: ReadonlyUint8Array }[]) =>
      messages.map(({ content }) => Object.freeze({ [signerAddress]: signContent(content) })),
    signTransactions: async (transactions: readonly { messageBytes: ReadonlyUint8Array }[]) =>
      transactions.map(({ messageBytes }) =>
        Object.freeze({ [signerAddress]: signContent(messageBytes) }),
      ),
  }) as unknown as KeyPairSigner;
}

export function generateSyncSigner(): KeyPairSigner {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicBytes = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return createSyncSigner(new Uint8Array(Buffer.concat([seed, publicBytes])));
}

export type KeyPairSignerLike =
  KeyPairSigner | Readonly<{ publicKey: PublicKeyLike; secretKey: Uint8Array }>;

export function ensureKeyPairSigner(value: KeyPairSignerLike): KeyPairSigner {
  return "address" in value ? value : createSyncSigner(value.secretKey);
}

export function asAddress(value: string): Address {
  return address(value);
}

export function addressFromBytes(bytes: ReadonlyUint8Array): Address {
  return address(getBase58Decoder().decode(bytes));
}

export function addressBytes(value: Address): ReadonlyUint8Array {
  return getAddressEncoder().encode(value);
}

export function derivePdaSync(
  programAddress: Address,
  seeds: readonly ReadonlyUint8Array[],
): Address {
  if (seeds.length > 16 || seeds.some((seed) => seed.length > 32)) {
    throw new Error("Invalid program-derived-address seeds");
  }
  for (let bump = 255; bump >= 0; bump -= 1) {
    const digest = createHash("sha256")
      .update(
        Buffer.concat([
          ...seeds.map((seed) => Buffer.from(seed)),
          Buffer.from([bump]),
          Buffer.from(addressBytes(programAddress)),
          PDA_MARKER,
        ]),
      )
      .digest();
    if (!compressedPointIsOnCurve(digest)) return addressFromBytes(digest);
  }
  throw new Error("Unable to derive program address");
}

export async function fetchAccount(
  rpc: OracleRpc,
  accountAddress: Address,
): Promise<EncodedAccount | null> {
  const response = await sendRpcRequest(
    rpc.getAccountInfo(accountAddress, { commitment: "confirmed", encoding: "base64" }),
  );
  const raw =
    response && typeof response === "object" && "value" in response ? response.value : response;
  if (!raw) return null;
  const data = (raw as { data: unknown }).data;
  if (Array.isArray(data)) {
    return parseBase64RpcAccount(accountAddress, raw as never);
  }
  const legacy = raw as unknown as {
    data: ReadonlyUint8Array;
    executable: boolean;
    lamports: number | bigint;
    owner: PublicKeyLike;
    rentEpoch?: number | bigint;
  };
  return {
    address: accountAddress,
    data: legacy.data,
    executable: legacy.executable,
    lamports: BigInt(legacy.lamports),
    programAddress: ensureLegacyAddress(legacy.owner),
    space: BigInt(legacy.data.length),
  } as EncodedAccount;
}

function ensureLegacyAddress(value: PublicKeyLike): Address {
  if (typeof value === "string") return address(value);
  if (value && typeof value === "object" && "toBase58" in value) {
    return address((value as { toBase58(): string }).toBase58());
  }
  throw new Error("Invalid account owner address");
}

export function parseRpcAccount<TAddress extends string>(
  accountAddress: Address<TAddress>,
  account: Parameters<typeof parseBase64RpcAccount<TAddress>>[1],
) {
  return parseBase64RpcAccount(accountAddress, account);
}

export function bytesToBase64(bytes: ReadonlyUint8Array): string {
  return getBase64Decoder().decode(bytes);
}

export function base64ToBytes(value: string): ReadonlyUint8Array {
  return getBase64Encoder().encode(value as Base64EncodedBytes);
}

export function asSignature(value: string): Signature {
  return signature(value);
}

/** Resolves both Kit pending RPC requests and promise-based test doubles. */
export async function sendRpcRequest<T>(
  request: { send(): Promise<T> } | PromiseLike<T>,
): Promise<T> {
  if ("send" in request && typeof request.send === "function") return request.send();
  return (await request) as T;
}
