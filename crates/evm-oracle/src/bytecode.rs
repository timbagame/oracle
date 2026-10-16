//! Helper contracts for signature checks, vendored from viem.

/// Universal ERC-6492 signature validator deployed per `eth_call`.
pub const ERC6492_VALIDATOR_BYTECODE: &str = include_str!("../abi/erc6492-validator.hex");

/// Multicall3 runtime used for deployless ERC-8010 checks.
pub const MULTICALL3_BYTECODE: &str = include_str!("../abi/multicall3.hex");

/// viem's `deploylessCallViaBytecodeBytecode`: deploys `code`, then calls it with `data`.
pub const DEPLOYLESS_CALL_BYTECODE: &str = include_str!("../abi/deployless-call.hex");
