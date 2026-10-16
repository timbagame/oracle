//! Contract bindings generated from the vendored protocol ABI
//! (`@timbagame/protocol/evm/v0.1.0/timba.json`).

alloy_sol_types::sol!(
    #[derive(Debug, PartialEq, Eq)]
    Timba,
    "abi/timba-v0.1.0.json"
);

pub use Timba::*;

/// Universal ERC-6492 signature validator deployed per `eth_call` (vendored from viem).
pub const ERC6492_VALIDATOR_BYTECODE: &str = include_str!("../../abi/erc6492-validator.hex");

/// Multicall3 runtime used for deployless ERC-8010 checks (vendored from viem).
pub const MULTICALL3_BYTECODE: &str = include_str!("../../abi/multicall3.hex");

/// viem's `deploylessCallViaBytecodeBytecode`: deploys `code`, then calls it with `data`.
pub const DEPLOYLESS_CALL_BYTECODE: &str = include_str!("../../abi/deployless-call.hex");
