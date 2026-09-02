import currentIdl from "./idl/idl.json";

const CONTRACT_VERSION = "0.3.0";
if (currentIdl.metadata.version !== CONTRACT_VERSION) {
  throw new Error(
    `Unsupported contract IDL version ${currentIdl.metadata.version}; expected ${CONTRACT_VERSION}`,
  );
}

export const contractIdl = currentIdl;
export const contractVersion = CONTRACT_VERSION;
