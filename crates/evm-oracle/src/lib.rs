//! Opt-in EVM oracle: creation authorizations, private-game invitations, settlement
//! of authorized games and a canonical event index for one configured deployment.

pub mod app;
pub mod bytecode;
pub mod config;
pub mod erc8010;
pub mod rpc;
pub mod server;
pub mod service;
pub mod store;
pub mod wallet;
