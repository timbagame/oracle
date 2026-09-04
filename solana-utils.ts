import { createHash } from "crypto";
import {
  address,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { sendRpcRequest, type LatestBlockhash, type OracleRpc } from "./solana-kit.ts";

type PublicKeyRecord = {
  toBase58?: () => string;
  value?: unknown;
  some?: unknown;
  toString?: () => unknown;
};

type PublicKeyInput =
  PublicKey | Address | string | ReadonlyUint8Array | number[] | PublicKeyRecord | null | undefined;

export type PublicKeyLike = PublicKeyInput;

function describeTransactionError(error: unknown): string {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function assertTransactionSucceeded(signature: string, result: unknown): void {
  if (!result || typeof result !== "object" || !("value" in result)) return;
  const value = (result as { value?: unknown }).value;
  if (!value || typeof value !== "object" || !("err" in value)) return;
  const error = (value as { err?: unknown }).err;
  if (error !== null && error !== undefined) {
    throw new Error(`Transaction ${signature} failed: ${describeTransactionError(error)}`);
  }
}

export class PublicKey {
  public readonly address: Address;

  constructor(value: string | ReadonlyUint8Array | number[]) {
    this.address =
      typeof value === "string"
        ? address(value)
        : address(getBase58Decoder().decode(Uint8Array.from(value)));
  }

  public toBase58(): string {
    return this.address;
  }

  public toString(): string {
    return this.address;
  }

  public toBytes(): Uint8Array {
    return new Uint8Array(getAddressEncoder().encode(this.address));
  }

  public toBuffer(): Buffer {
    return Buffer.from(this.toBytes());
  }

  public equals(other: PublicKeyLike): boolean {
    return coercePublicKey(other)?.address === this.address;
  }
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function hasToBase58Method(value: object): value is { toBase58: () => string } {
  return typeof (value as { toBase58?: unknown }).toBase58 === "function";
}

export function coercePublicKey(value: PublicKeyLike): PublicKey | null {
  if (!value) {
    return null;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  if (value instanceof Uint8Array || Array.isArray(value)) {
    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  if (isArrayBufferView(value)) {
    try {
      return new PublicKey(new Uint8Array(value.buffer));
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    const candidate = value as PublicKeyRecord;

    if (hasToBase58Method(candidate)) {
      try {
        return new PublicKey(candidate.toBase58());
      } catch {
        return null;
      }
    }

    if ("value" in candidate) {
      return coercePublicKey(candidate.value as PublicKeyLike);
    }

    if ("some" in candidate) {
      return coercePublicKey(candidate.some as PublicKeyLike);
    }
  }

  return null;
}

export function ensurePublicKey(value: PublicKeyLike | PublicKey): PublicKey {
  const normalized = value instanceof PublicKey ? value : coercePublicKey(value);
  if (!normalized) {
    throw new Error("Invalid public key provided");
  }
  return normalized;
}

export function coerceAddress(value: PublicKeyLike): Address | null {
  return coercePublicKey(value)?.address ?? null;
}

export function ensureAddress(value: PublicKeyLike): Address {
  const normalized = coerceAddress(value);
  if (!normalized) throw new Error("Invalid Solana address provided");
  return normalized;
}

export function toBase58(value: PublicKeyLike): string | undefined {
  const key = coercePublicKey(value);
  if (key) {
    return key.toBase58();
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const candidate = value as PublicKeyRecord;
    if (typeof candidate.toString === "function") {
      const asString = candidate.toString();
      return typeof asString === "string" ? asString : undefined;
    }
  }

  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    const result = fn.toString();
    return typeof result === "string" ? result : undefined;
  }

  if (value && typeof value !== "object") {
    const asString = String(value);
    return typeof asString === "string" ? asString : undefined;
  }

  return undefined;
}

export function resolveNumericLike(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (!Number.isInteger(value)) return undefined;
    if (!Number.isSafeInteger(value)) return undefined;
    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n) return undefined;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  }

  const withToNumber = value as { toNumber?: () => number };
  if (typeof withToNumber.toNumber === "function") {
    return resolveNumericLike(withToNumber.toNumber());
  }

  const withValueOf = value as { valueOf?: () => number | bigint };
  if (typeof withValueOf.valueOf === "function") {
    const raw = withValueOf.valueOf();
    return resolveNumericLike(raw);
  }

  return undefined;
}

/** Polls signature status until the transaction is confirmed, fails, expires, or times out. */
export async function confirmTransaction(
  rpc: OracleRpc,
  transactionSignature: string,
  latestBlockhash: LatestBlockhash,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [{ value: statuses }, blockHeight] = await Promise.all([
      sendRpcRequest(
        rpc.getSignatureStatuses([transactionSignature as never], {
          searchTransactionHistory: true,
        }),
      ),
      sendRpcRequest(rpc.getBlockHeight({ commitment: "confirmed" })),
    ]);
    const status = statuses[0];
    if (status?.err) {
      assertTransactionSucceeded(transactionSignature, { value: status });
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    if (blockHeight > latestBlockhash.lastValidBlockHeight) {
      throw new Error(`Transaction ${transactionSignature} expired before confirmation`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Transaction ${transactionSignature} confirmation timed out`);
}

export function generateUnbiasedRandom(seed: Buffer, max: bigint): bigint {
  if (max <= 0n) {
    throw new Error("Unable to generate unbiased random number - game must be cancelled");
  }

  const maxU64 = 0xffff_ffff_ffff_ffffn;
  const maxValid = maxU64 - (maxU64 % max);

  const entropyHash = createHash("sha256").update(seed).digest();

  for (let startPos = 0; startPos <= entropyHash.length - 8; startPos++) {
    const randomU64 = entropyHash.readBigUInt64LE(startPos);
    if (randomU64 < maxValid) {
      return randomU64 % max;
    }
  }

  throw new Error("Unable to generate unbiased random number - game must be cancelled");
}
