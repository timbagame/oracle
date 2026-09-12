import {
  buildCreateGamePlan as buildSharedPlan,
  type CreateGameInput,
} from "@timbagame/protocol/solana/plans";
import { PROGRAM_ID } from "./program.ts";
import { contractVersion, type ContractVersion } from "./contract-version.ts";
export type { CreateGameInput } from "@timbagame/protocol/solana/plans";
export function buildCreateGamePlan(
  input: CreateGameInput,
  version: ContractVersion = contractVersion,
) {
  return buildSharedPlan(input, version, PROGRAM_ID);
}
