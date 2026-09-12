import { createContractAdapter as createSharedAdapter } from "@timbagame/protocol/solana/plans";
import { PROGRAM_ID } from "./program.ts";
import { contractVersion, type ContractVersion } from "./contract-version.ts";

export type {
  GameInstructionInput,
  CloseGameInstructionInput,
  GameInstructionPlan,
  TimbaContractAdapter,
} from "@timbagame/protocol/solana/plans";
export function createContractAdapter(version: ContractVersion = contractVersion) {
  return createSharedAdapter(version, PROGRAM_ID);
}
export const timbaContractAdapter = createContractAdapter();
