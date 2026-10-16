//! Rust port of the `@timbagame/protocol` modules used by the Timba oracle.
//!
//! The on-chain codecs mirror the Codama-generated TypeScript clients for the
//! v0.2.0 and v0.3.0 Timba program IDLs, which are vendored under `idl/` and
//! checked by the tests in this crate.

pub mod address;
pub mod amounts;
pub mod codec;
pub mod contracts;
pub mod events;
pub mod instruction;
pub mod plans;
pub mod randomness;
pub mod transaction;
pub mod validators;

pub use address::{Address, AddressError};
pub use contracts::ContractVersion;
pub use instruction::{AccountMeta, Instruction};
