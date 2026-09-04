import {
  AccountRole,
  address,
  compileTransaction,
  decompileTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signatureBytes,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type SignatureDictionary,
  type Transaction as KitTransaction,
} from "@solana/kit";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import {
  GameType as GameTypeV020,
  getInitializeGameInstructionDataEncoder as getInitializeEncoderV020,
  getJoinGameInstructionDataEncoder as getJoinEncoderV020,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import {
  GameType as GameTypeV030,
  getInitializeGameInstructionDataEncoder as getInitializeEncoderV030,
  getJoinGameInstructionDataEncoder as getJoinEncoderV030,
} from "@timbagame/protocol/contracts/v0.3.0/kit";

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

function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const p = (1n << 255n) - 19n;
  const d = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
  const littleEndian = Uint8Array.from(bytes);
  const signBit = littleEndian[31]! >> 7;
  littleEndian[31] = (littleEndian[31] ?? 0) & 0x7f;
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) y = (y << 8n) | BigInt(littleEndian[index]!);
  if (y >= p) return false;
  const y2 = mod(y * y, p);
  const u = mod(y2 - 1n, p);
  const v = mod(d * y2 + 1n, p);
  const x2 = mod(u * pow(v, p - 2n, p), p);
  let x = pow(x2, (p + 3n) / 8n, p);
  if (mod(x * x - x2, p) !== 0n) {
    const sqrtMinusOne = pow(2n, (p - 1n) / 4n, p);
    x = mod(x * sqrtMinusOne, p);
  }
  if (mod(x * x - x2, p) !== 0n) return false;
  if (Number(x & 1n) !== signBit) x = p - x;
  return !(x === 0n && signBit === 1);
}

export class PublicKey {
  static readonly default = new PublicKey("11111111111111111111111111111111");
  readonly address: Address;

  constructor(value: string | Uint8Array | number[]) {
    this.address =
      typeof value === "string"
        ? address(value)
        : address(getBase58Decoder().decode(Uint8Array.from(value)));
  }

  toBase58(): string {
    return this.address;
  }

  toString(): string {
    return this.address;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(getAddressEncoder().encode(this.address));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.toBytes());
  }

  equals(other: PublicKey | Address | string): boolean {
    return this.address === normalizeAddress(other);
  }

  static isOnCurve(bytes: Uint8Array): boolean {
    return isOnCurve(bytes);
  }

  static findProgramAddressSync(
    seeds: readonly Uint8Array[],
    programId: PublicKey | Address | string,
  ): [PublicKey, number] {
    const normalizedProgramId = normalizePublicKey(programId);
    for (let bump = 255; bump > 0; bump -= 1) {
      const digest = createHash("sha256")
        .update(
          Buffer.concat([
            ...seeds.map(Buffer.from),
            Buffer.from([bump]),
            normalizedProgramId.toBuffer(),
            PDA_MARKER,
          ]),
        )
        .digest();
      if (!isOnCurve(digest)) return [new PublicKey(digest), bump];
    }
    throw new Error("Unable to derive PDA");
  }
}

export class Keypair {
  readonly publicKey: PublicKey;
  readonly address: Address;
  readonly secretKey: Uint8Array;
  readonly keyPair = {} as CryptoKeyPair;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  private constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this.privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey.subarray(0, 32))]),
      format: "der",
      type: "pkcs8",
    });
    this.publicKey = new PublicKey(secretKey.subarray(32));
    this.address = this.publicKey.address;
  }

  static fromSecretKey(secretKey: Uint8Array): Keypair {
    if (secretKey.length !== 64) throw new Error("Keypair must contain 64 bytes");
    return new Keypair(Uint8Array.from(secretKey));
  }

  static generate(): Keypair {
    const seed = randomBytes(32);
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const publicBytes = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    return new Keypair(new Uint8Array(Buffer.concat([seed, publicBytes])));
  }

  sign(message: Uint8Array): Uint8Array {
    return sign(null, Buffer.from(message), this.privateKey);
  }

  async signMessages(
    messages: Parameters<KeyPairSigner["signMessages"]>[0],
  ): Promise<readonly SignatureDictionary[]> {
    return messages.map(({ content }) => ({
      [this.address]: signatureBytes(this.sign(content)),
    }));
  }

  async signTransactions(
    transactions: Parameters<KeyPairSigner["signTransactions"]>[0],
  ): Promise<readonly SignatureDictionary[]> {
    return transactions.map(({ messageBytes }) => ({
      [this.address]: signatureBytes(this.sign(Uint8Array.from(messageBytes))),
    }));
  }
}

type PublicKeyInput = PublicKey | Address | string;

function normalizeAddress(value: PublicKeyInput): Address {
  return value instanceof PublicKey ? value.address : address(String(value));
}

function normalizePublicKey(value: PublicKeyInput): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

export class TransactionInstruction {
  readonly programId: PublicKey;
  readonly keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  readonly data: Buffer;

  constructor(options: {
    programId: PublicKeyInput;
    keys?: Array<{ pubkey: PublicKeyInput; isSigner: boolean; isWritable: boolean }>;
    data?: Buffer | Uint8Array;
  }) {
    this.programId = normalizePublicKey(options.programId);
    this.keys = (options.keys ?? []).map((key) => ({
      ...key,
      pubkey: normalizePublicKey(key.pubkey),
    }));
    this.data = Buffer.from(options.data ?? []);
  }
}

function toKitInstruction(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: instruction.programId.address,
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      address: pubkey.address,
      role: isSigner
        ? isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: instruction.data,
  };
}

export class Transaction {
  feePayer?: PublicKey;
  recentBlockhash?: string;
  readonly instructions: TransactionInstruction[] = [];
  signatures: Array<{ publicKey: PublicKey; signature: Buffer | null }> = [];
  private readonly signers = new Map<string, Keypair>();

  constructor(options: { feePayer?: PublicKey; recentBlockhash?: string } = {}) {
    this.feePayer = options.feePayer;
    this.recentBlockhash = options.recentBlockhash;
  }

  add(...instructions: TransactionInstruction[]): this {
    this.instructions.push(...instructions);
    return this;
  }

  sign(...signers: Keypair[]): void {
    this.signers.clear();
    this.partialSign(...signers);
  }

  partialSign(...signers: Keypair[]): void {
    for (const signer of signers) this.signers.set(signer.publicKey.address, signer);
  }

  serialize(_options?: { requireAllSignatures?: boolean; verifySignatures?: boolean }): Buffer {
    const transaction = this.compile();
    return Buffer.from(getBase64Encoder().encode(getBase64EncodedWireTransaction(transaction)));
  }

  serializeMessage(): Buffer {
    return Buffer.from(this.compile().messageBytes);
  }

  verifySignatures(_requireAllSignatures = true): boolean {
    return true;
  }

  private compile(): KitTransaction {
    if (!this.feePayer || !this.recentBlockhash) throw new Error("Missing transaction lifetime");
    const message = {
      version: "legacy" as const,
      feePayer: { address: this.feePayer.address },
      lifetimeConstraint: {
        blockhash: this.recentBlockhash as never,
        lastValidBlockHeight: 2n ** 64n - 1n,
      },
      instructions: this.instructions.map(toKitInstruction),
    };
    let transaction = compileTransaction(message);
    const signatures = { ...transaction.signatures };
    for (const [signerAddress, signer] of this.signers) {
      const value = signer.sign(Uint8Array.from(transaction.messageBytes));
      signatures[signerAddress as Address] = signatureBytes(value);
      const existing = this.signatures.find(({ publicKey }) => publicKey.address === signerAddress);
      if (existing) existing.signature = Buffer.from(value);
      else this.signatures.push({ publicKey: signer.publicKey, signature: Buffer.from(value) });
    }
    for (const { publicKey, signature } of this.signatures) {
      signatures[publicKey.address] = signature ? signatureBytes(signature) : null;
    }
    transaction = { ...transaction, signatures };
    return transaction;
  }

  static from(bytes: Uint8Array): Transaction {
    const decoded = getTransactionDecoder().decode(bytes);
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(decoded.messageBytes),
    );
    const transaction = new Transaction({
      feePayer: new PublicKey(message.feePayer.address),
      recentBlockhash:
        "blockhash" in message.lifetimeConstraint
          ? message.lifetimeConstraint.blockhash
          : message.lifetimeConstraint.nonce,
    });
    for (const instruction of message.instructions as readonly Instruction[]) {
      transaction.add(
        new TransactionInstruction({
          programId: new PublicKey(instruction.programAddress),
          keys: (instruction.accounts ?? []).map((meta) => ({
            pubkey: new PublicKey(meta.address),
            isSigner: meta.role >= AccountRole.READONLY_SIGNER,
            isWritable: (meta.role & AccountRole.WRITABLE) !== 0,
          })),
          data: Buffer.from(instruction.data ?? []),
        }),
      );
    }
    transaction.signatures = Object.entries(decoded.signatures).map(([signerAddress, value]) => ({
      publicKey: new PublicKey(signerAddress),
      signature: value ? Buffer.from(value) : null,
    }));
    return transaction;
  }
}

export const SystemProgram = {
  programId: new PublicKey("11111111111111111111111111111111"),
  transfer(options: { fromPubkey: PublicKey; toPubkey: PublicKey; lamports: number | bigint }) {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(BigInt(options.lamports), 4);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: options.fromPubkey, isSigner: true, isWritable: true },
        { pubkey: options.toPubkey, isSigner: false, isWritable: true },
      ],
      data,
    });
  },
  nonceAdvance(options: { noncePubkey: PublicKey; authorizedPubkey: PublicKey }) {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(4, 0);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: options.noncePubkey, isSigner: false, isWritable: true },
        { pubkey: options.authorizedPubkey, isSigner: true, isWritable: false },
      ],
      data,
    });
  },
};

export const ComputeBudgetProgram = {
  programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
  setComputeUnitPrice(options: { microLamports: number | bigint }) {
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0);
    data.writeBigUInt64LE(BigInt(options.microLamports), 1);
    return new TransactionInstruction({ programId: this.programId, data });
  },
};

export type AccountInfo<TData> = {
  data: TData;
  executable: boolean;
  lamports: number;
  owner: PublicKey;
  rentEpoch: number;
};

export type BlockhashWithExpiryBlockHeight = {
  blockhash: string;
  lastValidBlockHeight: number;
};

export type Connection = Record<string, unknown>;
export type ConfirmedSignatureInfo = { signature: string; slot: number; err?: unknown };
export type TransactionResponse = { meta?: { logMessages?: string[] | null; err?: unknown } };
export type VersionedTransactionResponse = TransactionResponse;
export type SendOptions = Record<string, unknown>;

export class TransactionExpiredBlockheightExceededError extends Error {
  constructor(..._args: unknown[]) {
    super("Transaction expired: block height exceeded");
  }
}
export class TransactionExpiredTimeoutError extends Error {
  constructor(..._args: unknown[]) {
    super("Transaction expired: timeout");
  }
}
export class SendTransactionError extends Error {
  constructor(messageOrOptions?: string | { transactionMessage?: string; [key: string]: unknown }) {
    super(
      typeof messageOrOptions === "string"
        ? messageOrOptions
        : (messageOrOptions?.transactionMessage ?? "Transaction failed"),
    );
  }
}

export class BN {
  constructor(private readonly value: number | bigint | string) {}
  toNumber(): number {
    return Number(this.value);
  }
  toString(): string {
    return String(this.value);
  }
  valueOf(): bigint {
    return BigInt(this.value);
  }
}

export class BorshInstructionCoder {
  constructor(_idl?: unknown) {}

  encode(name: string, args: Record<string, unknown>): Buffer {
    const legacy = process.env["CONTRACT_VERSION"] === "0.2.0";
    if (name === "joinGame") {
      return Buffer.from((legacy ? getJoinEncoderV020() : getJoinEncoderV030()).encode({}));
    }
    if (name !== "initializeGame") throw new Error(`Unsupported test instruction: ${name}`);
    const config = args["config"] as Record<string, unknown>;
    const gameType = config["gameType"] as Record<string, unknown>;
    const coinflip = "coinflip" in gameType;
    const input = {
      gameType: coinflip
        ? legacy
          ? GameTypeV020.Coinflip
          : GameTypeV030.Coinflip
        : legacy
          ? GameTypeV020.Giveaway
          : GameTypeV030.Giveaway,
      amount: BigInt(String(config["amount"])),
      maxTickets: Number(config["maxTickets"]),
      minTickets: Number(config["minTickets"]),
      timeout: BigInt(String(config["timeout"])),
      isPrivate: config["isPrivate"] === true,
      randomHash: Uint8Array.from(args["randomHash"] as number[]),
    };
    return Buffer.from(
      legacy ? getInitializeEncoderV020().encode(input) : getInitializeEncoderV030().encode(input),
    );
  }
}

export type Program<T = unknown> = T & {
  idl: any;
  programId: PublicKey;
  account: any;
  methods: any;
  provider: any;
  addEventListener: (...args: any[]) => Promise<number>;
  removeEventListener: (id: number) => Promise<void>;
};

const KeypairFixture = Keypair;
const PublicKeyFixture = PublicKey;
const TransactionFixture = Transaction;
const TransactionInstructionFixture = TransactionInstruction;
const SystemProgramFixture = SystemProgram;
const ComputeBudgetProgramFixture = ComputeBudgetProgram;

// A namespace is required to preserve the `web3` type/value shape in legacy test fixtures.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace web3 {
  export const Keypair = KeypairFixture;
  export const PublicKey = PublicKeyFixture;
  export const Transaction = TransactionFixture;
  export const TransactionInstruction = TransactionInstructionFixture;
  export const SystemProgram = SystemProgramFixture;
  export const ComputeBudgetProgram = ComputeBudgetProgramFixture;
  export type Keypair = import("./solana-fixtures.ts").Keypair;
  export type PublicKey = import("./solana-fixtures.ts").PublicKey;
  export type Transaction = import("./solana-fixtures.ts").Transaction;
  export type VersionedTransaction = import("./solana-fixtures.ts").Transaction;
  export type TransactionInstruction = import("./solana-fixtures.ts").TransactionInstruction;
  export type Connection = Record<string, any>;
  export type SendOptions = Record<string, unknown>;
  export type ConfirmOptions = Record<string, unknown>;
  export type ConfirmedSignatureInfo = import("./solana-fixtures.ts").ConfirmedSignatureInfo;
  export type TransactionResponse = import("./solana-fixtures.ts").TransactionResponse;
  export type VersionedTransactionResponse =
    import("./solana-fixtures.ts").VersionedTransactionResponse;
}
