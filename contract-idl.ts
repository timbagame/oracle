import legacyIdl from "./idl/idl-0.1.3.json";
import currentIdl from "./idl/idl.json";

export type ContractVersion = "0.1.3" | "0.2.0";

export function resolveContractVersion(
  value = process.env["TIMBA_CONTRACT_VERSION"] ?? "0.1.3",
): ContractVersion {
  if (value !== "0.1.3" && value !== "0.2.0")
    throw new Error(`TIMBA_CONTRACT_VERSION must be 0.1.3 or 0.2.0; got ${value}`);
  return value;
}

export function getContractIdl(version: ContractVersion): any {
  return version === "0.1.3" ? legacyIdl : currentIdl;
}

export const contractVersion = resolveContractVersion();
export const contractIdl = getContractIdl(contractVersion);
