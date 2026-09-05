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
} from "@solana/kit";
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

export type KeyPairSignerLike =
  KeyPairSigner | Readonly<{ publicKey: PublicKeyLike; secretKey: Uint8Array }>;

export async function ensureKeyPairSigner(value: KeyPairSignerLike): Promise<KeyPairSigner> {
  return "address" in value ? value : createKeyPairSignerFromBytes(value.secretKey);
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
