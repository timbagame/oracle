import { SUPPORTED_CONTRACT_VERSIONS, type ContractVersion } from "@timbagame/protocol/contracts";
import { timbaIdlV020 } from "@timbagame/protocol/contracts/v0.2.0";
import { timbaIdlV030 } from "@timbagame/protocol/contracts/v0.3.0";

export {
  CONTRACT_CAPABILITIES,
  DEFAULT_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  getContractCapabilities,
  parseContractVersion,
  type ContractCapabilities,
  type ContractVersion,
} from "@timbagame/protocol/contracts";

const idls = {
  "0.2.0": timbaIdlV020,
  "0.3.0": timbaIdlV030,
} as const;

for (const version of SUPPORTED_CONTRACT_VERSIONS) {
  const idl = idls[version];
  if (idl.metadata.version !== version) {
    throw new Error(`Contract IDL version ${idl.metadata.version} does not match ${version}`);
  }
}

export function getContractIdl(version: ContractVersion) {
  return idls[version];
}
