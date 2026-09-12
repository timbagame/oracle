import { address, type Address, type ReadonlyUint8Array } from "@solana/kit";
import {
  findGamePda,
  findGameVaultPda,
  findOraclePda,
} from "@timbagame/protocol/contracts/v0.3.0/kit";
import { findGameTokenPda } from "@timbagame/protocol/contracts/v0.2.0/kit";
import { getContractIdl } from "../contract-idl.ts";
import { contractVersion } from "./contract-version.ts";

export const PROGRAM_ID = address(getContractIdl(contractVersion).address);

export async function getOraclePDA(): Promise<Address> {
  return (await findOraclePda({ programAddress: PROGRAM_ID }))[0];
}

export async function getGameTokenPDA(tokenMint: Address): Promise<Address> {
  return (await findGameTokenPda({ tokenMint }, { programAddress: PROGRAM_ID }))[0];
}

export async function getGameVaultPDA(tokenMint: Address): Promise<Address> {
  return (await findGameVaultPda({ tokenMint }, { programAddress: PROGRAM_ID }))[0];
}

export async function getGamePDA(randomHash: ReadonlyUint8Array): Promise<Address> {
  return (await findGamePda({ randomHash }, { programAddress: PROGRAM_ID }))[0];
}
