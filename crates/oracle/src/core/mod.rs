//! Core oracle: completion, event processing, scanning and signing.

pub mod completion;
pub mod events;
pub mod expiry;
pub mod registry;
pub mod scan;
pub mod service;
pub mod signer;
#[cfg(test)]
pub mod testing;
pub mod types;
