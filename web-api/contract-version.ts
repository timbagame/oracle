import { getContractCapabilities, parseContractVersion } from "@timbagame/protocol/contracts";
export const contractVersion = parseContractVersion(process.env["CONTRACT_VERSION"]);
export const contractCapabilities = getContractCapabilities(contractVersion);
export { type ContractVersion } from "@timbagame/protocol/contracts";
