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
