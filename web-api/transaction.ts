import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type BlockhashLifetimeConstraint,
  type Instruction,
  type Transaction,
} from "@solana/kit";

export function createLegacyTransaction(
  feePayer: Address,
  lifetime: BlockhashLifetimeConstraint,
  instructions: readonly Instruction[],
) {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (message) => setTransactionMessageFeePayer(feePayer, message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstructions(instructions, message),
    ),
  );
}

export function decodeTransactionBase64(value: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(value));
}

export function encodeTransactionBase64(transaction: Transaction): string {
  return getBase64EncodedWireTransaction(transaction);
}
