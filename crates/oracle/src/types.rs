//! Types shared between the oracle service and its HTTP surfaces.

use futures::future::BoxFuture;
use serde::Serialize;
use std::sync::Arc;
use timba_protocol::Address;

use crate::solana::RpcPool;
use crate::token::policy::TokenPolicy;

/// Commitment returned when the oracle reserves a new game (`GameSecrets`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSecrets {
    /// Hex-encoded sha256 of the secret.
    pub random_hash: String,
    pub game_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oracle_operator: Option<String>,
}

/// The oracle operations the public web and HTTP layers depend on.
pub trait WebGameOracle: Send + Sync {
    fn rpc(&self) -> Arc<RpcPool>;
    fn program_id(&self) -> Address;
    /// Generates, stores and tracks a fresh commitment.
    fn generate_game_secrets<'a>(&'a self, game_type: Option<&'a str>) -> BoxFuture<'a, anyhow::Result<GameSecrets>>;
    /// Validates a creator-signed game transaction and co-signs it as the
    /// oracle operator, returning the base64 wire transaction.
    fn sign_game_transaction<'a>(&'a self, tx_base64: &'a str) -> BoxFuture<'a, anyhow::Result<String>>;
    /// Token policies with USD-derived minimums (fails when prices are
    /// unavailable).
    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>>;
}
