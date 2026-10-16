//! Indexer data types (port of `indexer/types.ts`). The decoded program
//! events are shared with the listener and live in `crate::indexed_events`.

use serde::Serialize;

pub use crate::indexed_events::{
    GameClosedEvent, GameCompletedEvent, GameInitializedEvent, IndexedEvents, MembershipKind, PlayerMembershipEvent,
};

/// A SQLite row as returned by `bun:sqlite` (`SELECT *` shaped objects). The
/// API layer reads columns from it the same way the TypeScript code did.
pub type Row = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexerCursor {
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalBackfillState {
    pub before_signature: Option<String>,
    pub pages: i64,
    pub transactions: i64,
    pub initialized_events: i64,
    pub closed_events: i64,
    pub complete: bool,
}
