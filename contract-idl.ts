import currentIdl from "./idl/idl.json";
import legacyIdl from "./idl/v0.2.0.json";

export const SUPPORTED_CONTRACT_VERSIONS = ["0.2.0", "0.3.0"] as const;
export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

const idls = {
  "0.2.0": legacyIdl,
  "0.3.0": currentIdl,
} as const;

for (const version of SUPPORTED_CONTRACT_VERSIONS) {
  const idl = idls[version];
  if (idl.metadata.version !== version) {
    throw new Error(`Contract IDL version ${idl.metadata.version} does not match ${version}`);
  }
}

export function parseContractVersion(value: string | undefined): ContractVersion {
  const version = value?.trim() || "0.2.0";
  if ((SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(version)) {
    return version as ContractVersion;
  }
  throw new Error(
    `CONTRACT_VERSION must be one of ${SUPPORTED_CONTRACT_VERSIONS.join(", ")}; received ${version}`,
  );
}

export function getContractIdl(version: ContractVersion) {
  return idls[version];
}

export const contractIdl = currentIdl;
export const contractVersion = "0.3.0" as const;
