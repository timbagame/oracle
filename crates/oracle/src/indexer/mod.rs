//! Public game indexer: program history ingestion into SQLite, materialized
//! stats and the `/indexer` HTTP API (port of `indexer/` and
//! `scripts/import-indexer.ts`).

pub mod api;
pub mod database;
pub mod import;
pub mod pricing;
pub mod schema;
pub mod service;
pub mod solana;
pub mod types;

pub use database::{IndexerDatabase, IndexerDatabaseOptions, LeaderboardPeriod, VerificationJob};
pub use service::PublicIndexer;
pub use types::IndexerCursor;

#[cfg(test)]
mod tests;
