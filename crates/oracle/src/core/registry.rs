//! Player registry analysis, on-chain recovery and completion-time
//! reconciliation (ports of `player-registry-utils.ts`,
//! `player-registry-sync.ts` and `registry-sync-manager.ts`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures::future::{BoxFuture, FutureExt, Shared};
use futures::StreamExt;
use timba_common::{error, info, warn};
use timba_protocol::Address;

use super::types::{GameContext, Readiness};
use crate::db::OracleDatabase;
use crate::indexed_events::{parse_transaction_events, MembershipKind};
use crate::solana::rpc::SignaturesForAddressOptions;
use crate::solana::RpcPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryStats {
    pub count: i64,
    pub max_index: Option<i64>,
    pub min_index: Option<i64>,
}

impl RegistryStats {
    /// Stats for a dense list of players (indexes `0..len`).
    pub fn dense(len: usize) -> Self {
        let count = len as i64;
        Self { count, max_index: (count > 0).then(|| count - 1), min_index: (count > 0).then_some(0) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryAnalysis {
    pub contiguous: bool,
    pub expected_matches: bool,
    pub normalized_expected: Option<i64>,
    pub needs_reconciliation: bool,
}

pub fn analyze_registry_state(stats: RegistryStats, expected_tickets: Option<i64>) -> RegistryAnalysis {
    let contiguous = match (stats.max_index, stats.min_index) {
        (Some(max), Some(min)) => max - min + 1 == stats.count,
        _ => stats.count == 0,
    };
    let expected_matches = expected_tickets.is_none_or(|expected| stats.count == expected);
    let raw = expected_tickets.unwrap_or_else(|| stats.max_index.map(|m| m + 1).unwrap_or(stats.count));
    RegistryAnalysis {
        contiguous,
        expected_matches,
        normalized_expected: (raw > 0).then_some(raw),
        needs_reconciliation: !contiguous || !expected_matches,
    }
}

pub fn summarize_ticket_assignments(assignments: &BTreeMap<i64, String>) -> RegistryStats {
    RegistryStats {
        count: assignments.len() as i64,
        max_index: assignments.keys().next_back().copied(),
        min_index: assignments.keys().next().copied(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryEvent {
    Join { ticket_index: i64, player_address: String },
    Unjoin { ticket_index: i64, moved_participant: Option<String> },
}

/// Replays join/unjoin events (oldest first) into ticket assignments.
pub fn replay_registry_events<'a>(events: impl IntoIterator<Item = &'a RegistryEvent>) -> BTreeMap<i64, String> {
    let mut assignments: BTreeMap<i64, String> = BTreeMap::new();
    for event in events {
        match event {
            RegistryEvent::Unjoin { ticket_index, moved_participant } => {
                assignments.remove(ticket_index);
                if let Some(moved) = moved_participant {
                    let moved_index = assignments.iter().find(|(_, p)| *p == moved).map(|(i, _)| *i);
                    if let Some(index) = moved_index {
                        assignments.remove(&index);
                    }
                    assignments.insert(*ticket_index, moved.clone());
                }
            }
            RegistryEvent::Join { ticket_index, player_address } => {
                assignments.insert(*ticket_index, player_address.clone());
            }
        }
    }
    assignments
}

/// Rebuilds a game's ordered player list from its transaction history.
pub struct PlayerRegistrySync {
    rpc: Arc<RpcPool>,
    program_id: Address,
    batch_size: usize,
    max_batches: usize,
    concurrency: usize,
}

impl PlayerRegistrySync {
    pub fn new(rpc: Arc<RpcPool>, program_id: Address) -> Self {
        Self::with_limits(rpc, program_id, 500, 6, 4)
    }

    pub fn with_limits(
        rpc: Arc<RpcPool>,
        program_id: Address,
        batch_size: usize,
        max_batches: usize,
        concurrency: usize,
    ) -> Self {
        Self {
            rpc,
            program_id,
            batch_size: batch_size.max(10),
            max_batches: max_batches.max(1),
            concurrency: concurrency.clamp(1, 10),
        }
    }

    pub async fn fetch_players_from_chain(
        &self,
        game_pda: &Address,
        expected_tickets: Option<i64>,
        max_signatures: Option<usize>,
    ) -> anyhow::Result<Option<Vec<String>>> {
        let signatures = self.collect_signatures(game_pda, max_signatures).await?;
        if signatures.is_empty() {
            return Ok(None);
        }
        let program_id = self.program_id.to_base58();
        let events: Vec<Vec<RegistryEvent>> = futures::stream::iter(signatures)
            .map(|(signature, slot)| {
                let program_id = program_id.clone();
                async move {
                    match self.rpc.get_transaction(&signature).await {
                        Ok(transaction) => {
                            // A failed transaction still logs events from instructions that
                            // ran before the failure; replaying them corrupts the roster.
                            let logs =
                                transaction.filter(|t| t.err.is_none()).map(|t| t.log_messages).unwrap_or_default();
                            parse_registry_events(&logs, &signature, slot, &program_id).unwrap_or_else(|message| {
                                warn!("Failed to fetch transaction {signature}: {message}");
                                Vec::new()
                            })
                        }
                        Err(error) => {
                            warn!("Failed to fetch transaction {signature}: {error}");
                            Vec::new()
                        }
                    }
                }
            })
            .buffered(self.concurrency)
            .collect()
            .await;

        let assignments = replay_registry_events(events.iter().flatten());
        if assignments.is_empty() {
            return Ok(None);
        }
        let analysis = analyze_registry_state(summarize_ticket_assignments(&assignments), expected_tickets);
        if !analysis.contiguous {
            let indexes: Vec<String> = assignments.keys().map(|i| i.to_string()).collect();
            warn!("Recovered player registry for {game_pda} contains gaps (indexes: {})", indexes.join(","));
            return Ok(None);
        }
        if !analysis.expected_matches {
            return Ok(None);
        }
        Ok(Some(assignments.into_values().collect()))
    }

    async fn collect_signatures(
        &self,
        game_pda: &Address,
        max_signatures: Option<usize>,
    ) -> anyhow::Result<Vec<(String, u64)>> {
        let mut collected: Vec<(String, u64)> = Vec::new();
        let mut before: Option<String> = None;
        for _ in 0..self.max_batches {
            if max_signatures.is_some_and(|max| collected.len() >= max) {
                break;
            }
            let remaining = max_signatures.map_or(self.batch_size, |max| max - collected.len());
            let limit = remaining.min(self.batch_size).max(1);
            let options =
                SignaturesForAddressOptions { before: before.clone(), until: None, limit: Some(limit as u32) };
            let page = self.rpc.get_signatures_for_address(game_pda, &options).await?;
            if page.is_empty() {
                break;
            }
            let page_len = page.len();
            before = page.last().map(|s| s.signature.clone());
            collected.extend(page.into_iter().filter(|s| s.err.is_none()).map(|s| (s.signature, s.slot)));
            if page_len < limit {
                break;
            }
        }
        collected.reverse();
        Ok(collected)
    }
}

fn parse_registry_events(
    logs: &[String],
    signature: &str,
    slot: u64,
    program_id: &str,
) -> Result<Vec<RegistryEvent>, String> {
    if logs.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = parse_transaction_events(signature, slot, logs, program_id)?;
    Ok(parsed
        .membership
        .into_iter()
        .map(|event| match event.kind {
            MembershipKind::Joined => {
                RegistryEvent::Join { ticket_index: i64::from(event.ticket_index), player_address: event.player }
            }
            MembershipKind::Unjoined => RegistryEvent::Unjoin {
                ticket_index: i64::from(event.ticket_index),
                moved_participant: event.moved_participant,
            },
        })
        .collect())
}

/// Request passed to the registry recovery hook.
#[derive(Clone)]
pub struct RecoverRequest {
    pub game_address: String,
    pub context: GameContext,
    pub expected_tickets: i64,
    pub reason: &'static str,
}

pub type RecoverPlayerRegistry =
    Arc<dyn Fn(RecoverRequest) -> BoxFuture<'static, anyhow::Result<Option<Vec<String>>>> + Send + Sync>;

type SharedPrefetch = Shared<BoxFuture<'static, ()>>;

struct CachedAnalysis {
    count: i64,
    expected: i64,
    result: RegistryAnalysis,
}

/// Ensures the stored player list matches the on-chain ticket count before a
/// winner is drawn, recovering from chain history when needed.
pub struct RegistrySyncManager {
    db: Arc<OracleDatabase>,
    recover: Option<RecoverPlayerRegistry>,
    mark_desynced: bool,
    prefetch_cooldown_ms: i64,
    schedule: Mutex<HashMap<String, i64>>,
    prefetching: Mutex<HashMap<String, SharedPrefetch>>,
    attempted_recovery: Mutex<HashSet<String>>,
    analysis_cache: Mutex<HashMap<String, CachedAnalysis>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl RegistrySyncManager {
    pub fn new(
        db: Arc<OracleDatabase>,
        recover: Option<RecoverPlayerRegistry>,
        mark_desynced: bool,
        prefetch_cooldown_ms: Option<i64>,
    ) -> Self {
        Self {
            db,
            recover,
            mark_desynced,
            prefetch_cooldown_ms: prefetch_cooldown_ms.unwrap_or(60_000).max(1_000),
            schedule: Mutex::new(HashMap::new()),
            prefetching: Mutex::new(HashMap::new()),
            attempted_recovery: Mutex::new(HashSet::new()),
            analysis_cache: Mutex::new(HashMap::new()),
            now: Arc::new(timba_common::time::now_ms),
        }
    }

    fn desync(&self, game_address: &str) {
        if self.mark_desynced {
            if let Err(error) = self.db.mark_game_desynced(game_address) {
                error!("Failed to mark {game_address} as desynced: {error:#}");
            }
        }
    }

    /// Returns the ordered players, or the fatal error message to record.
    pub async fn ensure_players_in_sync(
        &self,
        game_address: &str,
        context: &GameContext,
        expected_entries: i64,
    ) -> Result<Vec<String>, &'static str> {
        if expected_entries <= 0 {
            error!("Ticket registry mismatch for {game_address}: expected at least 1 entry, found {expected_entries}");
            self.desync(game_address);
            return Err("No ticket entries available for completion");
        }

        let mut players = self.db.get_game_players(game_address);
        let initial = self.cached_or_analyze(game_address, players.len(), expected_entries);
        if !initial.needs_reconciliation && !players.is_empty() && !has_duplicates(&players) {
            return Ok(players);
        }

        if let Some(recovered) =
            self.try_recover_player_registry(game_address, context, expected_entries, players.len()).await
        {
            players = recovered;
        }

        let analysis = analyze_registry_state(RegistryStats::dense(players.len()), Some(expected_entries));
        self.analysis_cache.lock().unwrap().insert(
            game_address.to_string(),
            CachedAnalysis { count: players.len() as i64, expected: expected_entries, result: analysis },
        );
        if analysis.needs_reconciliation || has_duplicates(&players) || players.is_empty() {
            error!("Ticket registry mismatch for {game_address}: expected {expected_entries}, found {}", players.len());
            self.desync(game_address);
            self.reset_registry_prefetch_schedule(game_address);
            return Err("Ticket registry out of sync");
        }
        Ok(players)
    }

    fn cached_or_analyze(&self, game_address: &str, count: usize, expected: i64) -> RegistryAnalysis {
        let mut cache = self.analysis_cache.lock().unwrap();
        if let Some(cached) = cache.get(game_address) {
            if cached.count == count as i64 && cached.expected == expected {
                return cached.result;
            }
        }
        let result = analyze_registry_state(RegistryStats::dense(count), Some(expected));
        cache.insert(game_address.to_string(), CachedAnalysis { count: count as i64, expected, result });
        result
    }

    pub async fn try_recover_player_registry(
        &self,
        game_address: &str,
        context: &GameContext,
        expected_entries: i64,
        previous_count: usize,
    ) -> Option<Vec<String>> {
        let Some(recover) = &self.recover else {
            error!("Ticket registry mismatch for {game_address}: expected {expected_entries}, found {previous_count}");
            return None;
        };
        if !self.attempted_recovery.lock().unwrap().insert(game_address.to_string()) {
            return None;
        }
        // Released even if the completion future is dropped or panics mid-recovery;
        // a stale marker would desync every later completion of the game.
        struct Attempt<'a>(&'a Mutex<HashSet<String>>, &'a str);
        impl Drop for Attempt<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(self.1);
            }
        }
        let attempt = Attempt(&self.attempted_recovery, game_address);
        let request = RecoverRequest {
            game_address: game_address.to_string(),
            context: context.clone(),
            expected_tickets: expected_entries,
            reason: "completion",
        };
        let outcome = recover(request).await;
        drop(attempt);
        match outcome {
            Ok(Some(recovered)) if recovered.len() as i64 == expected_entries => {
                if let Err(error) = self.db.replace_game_players(game_address, &recovered) {
                    error!("Player registry recovery failed for {game_address}: {error:#}");
                    return None;
                }
                self.analysis_cache.lock().unwrap().remove(game_address);
                info!("♻️  Recovered {} player entries for {game_address} before completion", recovered.len());
                Some(recovered)
            }
            Ok(recovered) => {
                error!(
                    "Unable to recover player registry for {game_address}; recovered {} of {expected_entries} entries",
                    recovered.map_or(0, |r| r.len())
                );
                None
            }
            Err(error) => {
                error!("Player registry recovery failed for {game_address}: {error:#}");
                None
            }
        }
    }

    pub async fn prefetch_player_registry(
        self: &Arc<Self>,
        game_address: &str,
        context: &GameContext,
        readiness: &Readiness,
    ) {
        let (Some(recover), Some(game)) = (self.recover.clone(), readiness.game_account.as_ref()) else {
            return;
        };
        let expected = i64::from(game.tickets_count);
        if expected <= 0 {
            return;
        }
        if self.db.get_game_players(game_address).len() as i64 >= expected {
            return;
        }
        let now = (self.now)();
        let next_allowed = self.schedule.lock().unwrap().get(game_address).copied().unwrap_or(0);
        if now < next_allowed {
            return;
        }

        let future = {
            let mut prefetching = self.prefetching.lock().unwrap();
            if let Some(existing) = prefetching.get(game_address) {
                existing.clone()
            } else {
                let manager = self.clone();
                let address = game_address.to_string();
                let request = RecoverRequest {
                    game_address: address.clone(),
                    context: context.clone(),
                    expected_tickets: expected,
                    reason: "readiness-check",
                };
                let future: SharedPrefetch = async move {
                    match recover(request).await {
                        Ok(Some(recovered)) if recovered.len() as i64 == expected => {
                            match manager.db.replace_game_players(&address, &recovered) {
                                Ok(()) => {
                                    manager.analysis_cache.lock().unwrap().remove(&address);
                                    info!(
                                        "♻️  Prefetched {} players for {address} during readiness evaluation",
                                        recovered.len()
                                    );
                                    manager
                                        .schedule
                                        .lock()
                                        .unwrap()
                                        .insert(address.clone(), now + manager.prefetch_cooldown_ms);
                                }
                                Err(error) => {
                                    manager.reset_registry_prefetch_schedule(&address);
                                    warn!("Unable to prefetch player registry for {address}: {error:#}");
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            manager.reset_registry_prefetch_schedule(&address);
                            warn!("Unable to prefetch player registry for {address}: {error:#}");
                        }
                    }
                    manager.prefetching.lock().unwrap().remove(&address);
                }
                .boxed()
                .shared();
                prefetching.insert(game_address.to_string(), future.clone());
                future
            }
        };
        future.await;
    }

    pub fn reset_registry_prefetch_schedule(&self, game_address: &str) {
        self.schedule.lock().unwrap().remove(game_address);
    }
}

fn has_duplicates(players: &[String]) -> bool {
    let unique: HashSet<&String> = players.iter().collect();
    unique.len() != players.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::fail_updates;

    #[test]
    fn analyzes_registry_state() {
        let a = analyze_registry_state(RegistryStats { count: 3, max_index: Some(2), min_index: Some(0) }, Some(3));
        assert!(a.contiguous && a.expected_matches && !a.needs_reconciliation);
        assert_eq!(a.normalized_expected, Some(3));
        let gap = analyze_registry_state(RegistryStats { count: 2, max_index: Some(2), min_index: Some(0) }, None);
        assert!(!gap.contiguous && gap.needs_reconciliation);
        assert_eq!(gap.normalized_expected, Some(3));
        let empty = analyze_registry_state(RegistryStats::dense(0), None);
        assert!(empty.contiguous && empty.normalized_expected.is_none());
        let mismatch = analyze_registry_state(RegistryStats::dense(2), Some(3));
        assert!(mismatch.needs_reconciliation);
    }

    #[test]
    fn replays_swap_remove_unjoins() {
        let events = vec![
            RegistryEvent::Join { ticket_index: 0, player_address: "a".into() },
            RegistryEvent::Join { ticket_index: 1, player_address: "b".into() },
            RegistryEvent::Join { ticket_index: 2, player_address: "c".into() },
            RegistryEvent::Unjoin { ticket_index: 0, moved_participant: Some("c".into()) },
            RegistryEvent::Unjoin { ticket_index: 1, moved_participant: None },
        ];
        let assignments = replay_registry_events(&events);
        assert_eq!(assignments.into_iter().collect::<Vec<_>>(), vec![(0, "c".to_string())]);
    }

    use crate::db::SecretKeyData;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::rpc::RpcError;
    use crate::solana::Keypair;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use timba_protocol::contracts::{GameAccount, GameType, PROGRAM_ID};
    use timba_protocol::events::discriminators;

    // -- PlayerRegistrySync ----------------------------------------------------

    fn key() -> String {
        Keypair::generate().address().to_base58()
    }

    fn membership_bytes(
        join: bool,
        game: &Address,
        player: &str,
        ticket_index: u32,
        tickets_count: u32,
        moved: Option<&str>,
    ) -> Vec<u8> {
        let disc = if join { discriminators::PLAYER_JOINED } else { discriminators::PLAYER_UNJOINED };
        let mut data = disc.to_vec();
        data.extend_from_slice(&game.0);
        data.extend_from_slice(&Address::parse(player).unwrap().0);
        data.extend_from_slice(&10u64.to_le_bytes());
        data.extend_from_slice(&tickets_count.to_le_bytes());
        data.extend_from_slice(&ticket_index.to_le_bytes());
        if !join {
            match moved {
                Some(moved) => {
                    data.push(1);
                    data.extend_from_slice(&Address::parse(moved).unwrap().0);
                }
                None => data.push(0),
            }
        }
        data.extend_from_slice(&5u64.to_le_bytes());
        data.extend_from_slice(&6u64.to_le_bytes());
        data
    }

    fn joined(game: &Address, player: &str, ticket_index: u32) -> Vec<u8> {
        membership_bytes(true, game, player, ticket_index, ticket_index + 1, None)
    }

    fn unjoined(game: &Address, player: &str, ticket_index: u32, moved: Option<&str>) -> Vec<u8> {
        membership_bytes(false, game, player, ticket_index, 1, moved)
    }

    fn program_logs(payloads: &[Vec<u8>]) -> Vec<String> {
        let program = PROGRAM_ID.to_base58();
        let mut logs = vec![format!("Program {program} invoke [1]")];
        for payload in payloads {
            logs.push(format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(payload)));
        }
        logs.push(format!("Program {program} success"));
        logs
    }

    /// Serves `history` (newest first, like the RPC) with `before`/`limit`
    /// paging and per-signature transaction logs.
    fn chain(history: Vec<(&'static str, Option<Vec<String>>)>) -> (Arc<FakeTransport>, Arc<RpcPool>) {
        let transport = FakeTransport::new();
        let signatures: Vec<&'static str> = history.iter().map(|(s, _)| *s).collect();
        transport.on(move |_, method, params| {
            (method == "getSignaturesForAddress").then(|| {
                let config = &params[1];
                let start = config["before"]
                    .as_str()
                    .map(|before| signatures.iter().position(|s| *s == before).unwrap() + 1)
                    .unwrap_or(0);
                let limit = config["limit"].as_u64().unwrap() as usize;
                let page: Vec<Value> = signatures
                    .iter()
                    .enumerate()
                    .skip(start)
                    .take(limit)
                    .map(|(i, s)| json!({"signature": s, "slot": 100 - i}))
                    .collect();
                Ok(Value::Array(page))
            })
        });
        let logs: HashMap<&'static str, Option<Vec<String>>> = history.into_iter().collect();
        transport.on(move |_, method, params| {
            (method == "getTransaction").then(|| {
                let signature = params[0].as_str().unwrap();
                Ok(match logs.get(signature).cloned().flatten() {
                    Some(logs) => json!({"slot": 1, "meta": {"err": null, "logMessages": logs}}),
                    None => Value::Null,
                })
            })
        });
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap());
        (transport, rpc)
    }

    fn signature_limits(transport: &FakeTransport) -> Vec<u64> {
        transport.calls_for("getSignaturesForAddress").iter().map(|(_, p)| p[1]["limit"].as_u64().unwrap()).collect()
    }

    #[tokio::test]
    async fn recovers_players_when_ticket_indexes_start_at_one() {
        let game = Address([7; 32]);
        let (one, two) = (key(), key());
        let (_, rpc) = chain(vec![("sig-1", Some(program_logs(&[joined(&game, &one, 1), joined(&game, &two, 2)])))]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), Some(vec![one, two]));
    }

    #[tokio::test]
    async fn ignores_events_from_failed_transactions() {
        let game = Address([7; 32]);
        let (one, two, three) = (key(), key(), key());
        let transport = FakeTransport::new();
        transport.on(|_, method, _| {
            (method == "getSignaturesForAddress").then(|| {
                Ok(json!([
                    {"signature": "failed-signature", "slot": 9, "err": {"InstructionError": [1, "Custom"]}},
                    {"signature": "failed-meta", "slot": 8, "err": null},
                    {"signature": "joins", "slot": 7}
                ]))
            })
        });
        let (joins, late_join, unjoin) = (
            program_logs(&[joined(&game, &one, 0), joined(&game, &two, 1)]),
            program_logs(&[joined(&game, &three, 2)]),
            program_logs(&[unjoined(&game, &two, 1, None)]),
        );
        transport.on(move |_, method, params| {
            (method == "getTransaction").then(|| {
                Ok(match params[0].as_str().unwrap() {
                    "joins" => json!({"slot": 7, "meta": {"err": null, "logMessages": joins}}),
                    // The join instruction ran, then a later instruction failed.
                    "failed-meta" => json!({"slot": 8, "meta": {"err": {"InstructionError": [1, "Custom"]}, "logMessages": late_join}}),
                    _ => json!({"slot": 9, "meta": {"err": null, "logMessages": unjoin}}),
                })
            })
        });
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap());
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), Some(vec![one, two]));
        let fetched: Vec<String> =
            transport.calls_for("getTransaction").iter().map(|(_, p)| p[0].as_str().unwrap().to_string()).collect();
        assert!(!fetched.contains(&"failed-signature".to_string()), "{fetched:?}");
    }

    #[tokio::test]
    async fn rejects_gaps_duplicates_and_partial_registries() {
        let game = Address([7; 32]);
        let (one, two) = (key(), key());
        let gap = program_logs(&[joined(&game, &one, 1), joined(&game, &two, 3)]);
        let (_, rpc) = chain(vec![("sig-1", Some(gap))]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), None);
        // Without an expected count, gaps are still rejected.
        assert_eq!(sync.fetch_players_from_chain(&game, None, None).await.unwrap(), None);

        let duplicate = program_logs(&[joined(&game, &one, 0), joined(&game, &two, 0)]);
        let (_, rpc) = chain(vec![("sig-1", Some(duplicate))]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), None);

        // Newest first: the unjoin happened after both joins.
        let (_, rpc) = chain(vec![
            ("sig-2", Some(program_logs(&[unjoined(&game, &one, 0, None)]))),
            ("sig-1", Some(program_logs(&[joined(&game, &one, 0), joined(&game, &two, 1)]))),
        ]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), None);
    }

    #[tokio::test]
    async fn honors_signature_limits() {
        let game = Address([7; 32]);
        let player = key();
        let (transport, rpc) = chain(vec![("sig-1", Some(program_logs(&[joined(&game, &player, 0)])))]);
        let sync = PlayerRegistrySync::new(rpc.clone(), PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), Some(1)).await.unwrap(), Some(vec![player.clone()]));
        assert_eq!(signature_limits(&transport), vec![1]);

        // Without a cap, requests never ask for zero signatures.
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), Some(vec![player]));
        assert!(signature_limits(&transport).iter().all(|limit| *limit > 0));
        // Versioned transactions are requested.
        let (_, params) = &transport.calls_for("getTransaction")[0];
        assert_eq!(params[1]["maxSupportedTransactionVersion"], 0);
    }

    #[tokio::test]
    async fn pages_beyond_the_ticket_count_to_find_earlier_joins() {
        let game = Address([7; 32]);
        let (survivor, replacement) = (key(), key());
        const NAMES: [&str; 10] = [
            "history-9",
            "history-8",
            "history-7",
            "history-6",
            "history-5",
            "history-4",
            "history-3",
            "history-2",
            "history-1",
            "history-0",
        ];
        let history = NAMES
            .iter()
            .map(|name| {
                let logs = match *name {
                    "history-0" => program_logs(&[joined(&game, &survivor, 0)]),
                    "history-9" => program_logs(&[joined(&game, &replacement, 1)]),
                    _ => Vec::new(),
                };
                (*name, Some(logs))
            })
            .collect();
        let (transport, rpc) = chain(history);
        let sync = PlayerRegistrySync::with_limits(rpc, PROGRAM_ID, 10, 6, 4);
        assert_eq!(
            sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(),
            Some(vec![survivor, replacement])
        );
        assert_eq!(signature_limits(&transport), vec![10, 10]);
        // The second page continues before the oldest signature seen.
        assert_eq!(transport.calls_for("getSignaturesForAddress")[1].1[1]["before"], "history-0");
    }

    #[tokio::test]
    async fn applies_events_in_chronological_order() {
        let game = Address([7; 32]);
        let (one, two) = (key(), key());
        let (_, rpc) = chain(vec![
            ("sig-2", Some(program_logs(&[joined(&game, &two, 0)]))),
            ("sig-1", Some(program_logs(&[unjoined(&game, &one, 0, None)]))),
            ("sig-0", Some(program_logs(&[joined(&game, &one, 0)]))),
        ]);
        let sync = PlayerRegistrySync::with_limits(rpc, PROGRAM_ID, 10, 1, 2);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), Some(vec![two]));
    }

    #[tokio::test]
    async fn rebuilds_registries_with_moved_participants() {
        let game = Address([7; 32]);
        let (first, second, third) = (key(), key(), key());
        let (_, rpc) = chain(vec![
            ("sig-1", Some(program_logs(&[unjoined(&game, &first, 0, Some(&third))]))),
            ("sig-2", Some(program_logs(&[membership_bytes(true, &game, &third, 2, 3, None)]))),
            ("sig-3", Some(program_logs(&[joined(&game, &first, 0), joined(&game, &second, 1)]))),
        ]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(2), None).await.unwrap(), Some(vec![third, second]));
    }

    #[tokio::test]
    async fn tolerates_missing_logs_and_failed_fetches() {
        let game = Address([7; 32]);
        let player = key();
        // No signatures at all.
        let (_, rpc) = chain(vec![]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), None);

        // Empty logs and missing transactions carry no events.
        let (_, rpc) = chain(vec![("sig-empty", Some(Vec::new())), ("sig-null", None)]);
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), None);

        // Malformed events and RPC failures only drop that transaction.
        let mut bad = joined(&game, &player, 1);
        bad.pop();
        let (transport, rpc) = chain(vec![
            ("sig-bad", Some(program_logs(&[bad]))),
            ("sig-fail", Some(Vec::new())),
            ("sig-ok", Some(program_logs(&[joined(&game, &player, 0)]))),
        ]);
        transport.push("getTransaction", Err(RpcError::json_rpc(-32000, "boom")));
        let sync = PlayerRegistrySync::with_limits(rpc, PROGRAM_ID, 1, 0, 0);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), None);
        assert_eq!(signature_limits(&transport), vec![10]);
        assert_eq!(sync.fetch_players_from_chain(&game, Some(1), None).await.unwrap(), Some(vec![player]));
    }

    #[tokio::test]
    async fn signature_failures_propagate() {
        let transport = FakeTransport::new();
        transport.on(|_, _, _| Some(Err(RpcError::json_rpc(-32602, "Invalid params"))));
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport).unwrap());
        let sync = PlayerRegistrySync::new(rpc, PROGRAM_ID);
        let err = sync.fetch_players_from_chain(&Address([7; 32]), Some(1), None).await.unwrap_err();
        assert_eq!(err.to_string(), "JSON-RPC error -32602: Invalid params");
    }

    #[test]
    fn summarizes_assignments() {
        assert_eq!(
            summarize_ticket_assignments(&BTreeMap::new()),
            RegistryStats { count: 0, max_index: None, min_index: None }
        );
        let assignments = BTreeMap::from([(2, "b".to_string()), (1, "a".to_string())]);
        assert_eq!(
            summarize_ticket_assignments(&assignments),
            RegistryStats { count: 2, max_index: Some(2), min_index: Some(1) }
        );
        assert_eq!(RegistryStats::dense(3), RegistryStats { count: 3, max_index: Some(2), min_index: Some(0) });
    }

    // -- RegistrySyncManager ---------------------------------------------------

    struct ManagerHarness {
        _dir: tempfile::TempDir,
        db: Arc<OracleDatabase>,
        calls: Arc<AtomicUsize>,
        manager: Arc<RegistrySyncManager>,
    }

    fn recover_fn(
        calls: Arc<AtomicUsize>,
        result: impl Fn(usize) -> anyhow::Result<Option<Vec<String>>> + Send + Sync + 'static,
    ) -> RecoverPlayerRegistry {
        let result = Arc::new(result);
        Arc::new(move |request: RecoverRequest| {
            assert!(request.reason == "completion" || request.reason == "readiness-check");
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            let outcome = result(n);
            async move { outcome }.boxed()
        })
    }

    fn manager_with(
        recover: Option<Box<dyn Fn(Arc<AtomicUsize>) -> RecoverPlayerRegistry>>,
        cooldown: Option<i64>,
        now: i64,
    ) -> ManagerHarness {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let recover = recover.map(|make| make(calls.clone()));
        let manager = Arc::new(RegistrySyncManager {
            now: Arc::new(move || now),
            ..RegistrySyncManager::new(db.clone(), recover, true, cooldown)
        });
        ManagerHarness { _dir: dir, db, calls, manager }
    }

    fn recovering(
        result: impl Fn(usize) -> anyhow::Result<Option<Vec<String>>> + Send + Sync + Clone + 'static,
    ) -> Option<Box<dyn Fn(Arc<AtomicUsize>) -> RecoverPlayerRegistry>> {
        Some(Box::new(move |calls| recover_fn(calls, result.clone())))
    }

    fn game_context() -> GameContext {
        GameContext {
            game_pda: Address([8; 32]),
            secret: SecretKeyData { secret_key: "aa".repeat(32), random_hash: "bb".repeat(32) },
            random_hash: [0xbb; 32],
            readiness: None,
        }
    }

    fn readiness(tickets: u32) -> Readiness {
        Readiness {
            ready: true,
            game_account: Some(GameAccount {
                creator: Address([1; 32]),
                game_type: GameType::Coinflip,
                ticket_amount: 1,
                max_tickets: tickets,
                min_tickets: 1,
                tickets_count: tickets,
                token_mint: Address([2; 32]),
                created_at: 0,
                timeout: 60,
                last_slot: 99,
                is_private: false,
                total_amount: 1,
                participants: Vec::new(),
            }),
            evaluated_at: Some(0),
        }
    }

    fn track(h: &ManagerHarness, game: &str, players: &[&str]) {
        h.db.track_game(game, None, false).unwrap();
        let players: Vec<String> = players.iter().map(|p| p.to_string()).collect();
        h.db.replace_game_players(game, &players).unwrap();
    }

    #[tokio::test]
    async fn clean_registries_skip_recovery() {
        let h = manager_with(recovering(|_| Ok(None)), None, 0);
        track(&h, "game1", &["p1"]);
        for _ in 0..2 {
            assert_eq!(h.manager.ensure_players_in_sync("game1", &game_context(), 1).await, Ok(vec!["p1".into()]));
        }
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn recovers_missing_players_when_sizes_match() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["p1".into(), "p2".into()]))), None, 0);
        track(&h, "game2", &[]);
        let players = h.manager.ensure_players_in_sync("game2", &game_context(), 2).await;
        assert_eq!(players, Ok(vec!["p1".to_string(), "p2".to_string()]));
        assert_eq!(h.db.get_game_players("game2"), vec!["p1".to_string(), "p2".to_string()]);
    }

    #[tokio::test]
    async fn duplicates_trigger_recovery_despite_matching_length() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["dup".into(), "other".into()]))), None, 0);
        track(&h, "dup-game", &["dup", "dup"]);
        let players = h.manager.ensure_players_in_sync("dup-game", &game_context(), 2).await;
        assert_eq!(players, Ok(vec!["dup".to_string(), "other".to_string()]));
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        // The duplicate check also guards the final registry.
        let h = manager_with(recovering(|_| Ok(Some(vec!["x".into(), "x".into()]))), None, 0);
        track(&h, "still-dup", &[]);
        let result = h.manager.ensure_players_in_sync("still-dup", &game_context(), 2).await;
        assert_eq!(result, Err("Ticket registry out of sync"));
    }

    #[tokio::test]
    async fn failed_recovery_marks_the_game_desynced() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["only-one".into()]))), None, 0);
        track(&h, "game3", &[]);
        h.manager.schedule.lock().unwrap().insert("game3".into(), 99);
        let result = h.manager.ensure_players_in_sync("game3", &game_context(), 2).await;
        assert_eq!(result, Err("Ticket registry out of sync"));
        assert_eq!(h.db.get_game_status("game3").as_deref(), Some("desynced"));
        assert!(!h.manager.schedule.lock().unwrap().contains_key("game3"), "prefetch schedule is reset");
    }

    #[tokio::test]
    async fn zero_expected_entries_are_fatal() {
        let h = manager_with(None, None, 0);
        h.db.track_game("zero", None, false).unwrap();
        let result = h.manager.ensure_players_in_sync("zero", &game_context(), 0).await;
        assert_eq!(result, Err("No ticket entries available for completion"));
        assert_eq!(h.db.get_game_status("zero").as_deref(), Some("desynced"));
    }

    #[tokio::test]
    async fn a_failed_desync_mark_still_reports_the_mismatch() {
        let h = manager_with(None, None, 0);
        h.db.track_game("zero", None, false).unwrap();
        fail_updates(h._dir.path(), "no_desync", "game_tracking", "NEW.status = 'desynced'");
        let result = h.manager.ensure_players_in_sync("zero", &game_context(), 0).await;
        assert_eq!(result, Err("No ticket entries available for completion"));
        assert_eq!(h.db.get_game_status("zero").as_deref(), Some("pending"));
    }

    #[tokio::test]
    async fn cached_analyses_are_recomputed_when_the_roster_changes() {
        let h = manager_with(recovering(|_| Ok(None)), None, 0);
        track(&h, "grow", &["p1"]);
        assert_eq!(h.manager.ensure_players_in_sync("grow", &game_context(), 1).await, Ok(vec!["p1".into()]));
        // A second ticket sold: the cached analysis for one player no longer applies.
        track(&h, "grow", &["p1", "p2"]);
        let players = h.manager.ensure_players_in_sync("grow", &game_context(), 2).await;
        assert_eq!(players, Ok(vec!["p1".to_string(), "p2".to_string()]));
        // A different expectation for the same roster is analysed afresh as well.
        assert_eq!(
            h.manager.ensure_players_in_sync("grow", &game_context(), 3).await,
            Err("Ticket registry out of sync")
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1, "only the mismatching roster needed recovery");
    }

    #[tokio::test]
    async fn desync_marking_can_be_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let manager = RegistrySyncManager::new(db.clone(), None, false, None);
        db.track_game("g", None, false).unwrap();
        assert_eq!(manager.ensure_players_in_sync("g", &game_context(), 1).await, Err("Ticket registry out of sync"));
        assert_eq!(db.get_game_status("g").as_deref(), Some("pending"));
    }

    #[tokio::test]
    async fn recovery_can_retry_after_a_failure() {
        let h = manager_with(
            recovering(|n| if n == 1 { Ok(None) } else { Ok(Some(vec!["a".into(), "b".into()])) }),
            None,
            0,
        );
        h.db.track_game("retry", None, false).unwrap();
        assert_eq!(h.manager.try_recover_player_registry("retry", &game_context(), 2, 1).await, None);
        assert_eq!(
            h.manager.try_recover_player_registry("retry", &game_context(), 2, 1).await,
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(h.db.get_game_players("retry"), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn recovery_errors_and_reentry_return_none() {
        let h = manager_with(recovering(|_| Err(anyhow::anyhow!("network"))), None, 0);
        assert_eq!(h.manager.try_recover_player_registry("g", &game_context(), 2, 0).await, None);
        // A recovery already running for the game is not started twice.
        h.manager.attempted_recovery.lock().unwrap().insert("g".into());
        assert_eq!(h.manager.try_recover_player_registry("g", &game_context(), 2, 0).await, None);
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        // Without a recovery hook there is nothing to try.
        let h = manager_with(None, None, 0);
        assert_eq!(h.manager.try_recover_player_registry("g", &game_context(), 2, 0).await, None);
    }

    #[tokio::test]
    async fn recovery_storage_failures_return_none() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["a".into()]))), None, 0);
        h.db.close();
        assert_eq!(h.manager.try_recover_player_registry("g", &game_context(), 1, 0).await, None);
        // Prefetch storage failures reset the schedule.
        h.manager.prefetch_player_registry("g", &game_context(), &readiness(1)).await;
        assert!(!h.manager.schedule.lock().unwrap().contains_key("g"));
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn enforces_a_minimum_prefetch_cooldown() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["p".into()]))), Some(0), 1_000);
        h.manager.prefetch_player_registry("cooldown-game", &game_context(), &readiness(1)).await;
        assert_eq!(h.manager.schedule.lock().unwrap().get("cooldown-game"), Some(&2_000));
        assert_eq!(h.db.get_game_players("cooldown-game"), vec!["p".to_string()]);

        // Within the cooldown no new prefetch starts.
        h.db.replace_game_players("cooldown-game", &[]).unwrap();
        h.manager.prefetch_player_registry("cooldown-game", &game_context(), &readiness(1)).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        h.manager.reset_registry_prefetch_schedule("cooldown-game");
        h.manager.prefetch_player_registry("cooldown-game", &game_context(), &readiness(1)).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn prefetch_retries_immediately_after_a_failure() {
        let h = manager_with(
            recovering(|n| if n == 1 { Err(anyhow::anyhow!("boom")) } else { Ok(Some(vec!["a".into(), "b".into()])) }),
            None,
            1_700_000_000_000,
        );
        h.manager.prefetch_player_registry("prefetch-retry", &game_context(), &readiness(2)).await;
        assert!(h.db.get_game_players("prefetch-retry").is_empty());
        h.manager.prefetch_player_registry("prefetch-retry", &game_context(), &readiness(2)).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
        assert_eq!(h.db.get_game_players("prefetch-retry"), vec!["a".to_string(), "b".to_string()]);
    }

    #[tokio::test]
    async fn prefetch_skips_when_nothing_to_do() {
        let h = manager_with(recovering(|_| Ok(Some(vec!["a".into()]))), None, 0);
        // No game account, zero tickets, or a complete registry.
        let mut no_account = readiness(1);
        no_account.game_account = None;
        h.manager.prefetch_player_registry("g", &game_context(), &no_account).await;
        h.manager.prefetch_player_registry("g", &game_context(), &readiness(0)).await;
        track(&h, "full", &["a"]);
        h.manager.prefetch_player_registry("full", &game_context(), &readiness(1)).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
        // Wrong-size recoveries are ignored.
        h.manager.prefetch_player_registry("g", &game_context(), &readiness(2)).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert!(h.db.get_game_players("g").is_empty());
        // Without a recovery hook prefetching is disabled.
        let h = manager_with(None, None, 0);
        h.manager.prefetch_player_registry("g", &game_context(), &readiness(1)).await;
    }

    fn blocking_recover(
        release: Arc<tokio::sync::Notify>,
        fail: bool,
    ) -> Option<Box<dyn Fn(Arc<AtomicUsize>) -> RecoverPlayerRegistry>> {
        Some(Box::new(move |calls| {
            let release = release.clone();
            Arc::new(move |_request: RecoverRequest| {
                calls.fetch_add(1, Ordering::SeqCst);
                let release = release.clone();
                async move {
                    release.notified().await;
                    if fail {
                        anyhow::bail!("network");
                    }
                    Ok(Some(vec!["a".to_string(), "b".to_string()]))
                }
                .boxed()
            })
        }))
    }

    #[tokio::test]
    async fn concurrent_prefetches_share_one_recovery() {
        let release = Arc::new(tokio::sync::Notify::new());
        let h = manager_with(blocking_recover(release.clone(), false), Some(1_000), 1_700_000_000_000);
        let (context, ready) = (game_context(), readiness(2));
        tokio::join!(
            h.manager.prefetch_player_registry("concurrent", &context, &ready),
            h.manager.prefetch_player_registry("concurrent", &context, &ready),
            async {
                tokio::task::yield_now().await;
                release.notify_one();
            }
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.db.get_game_players("concurrent").len(), 2);
        assert!(h.manager.prefetching.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn concurrent_prefetches_share_a_failure() {
        let release = Arc::new(tokio::sync::Notify::new());
        let h = manager_with(blocking_recover(release.clone(), true), None, 1_700_000_000_000);
        let (context, ready) = (game_context(), readiness(2));
        tokio::join!(
            h.manager.prefetch_player_registry("fails", &context, &ready),
            h.manager.prefetch_player_registry("fails", &context, &ready),
            async {
                tokio::task::yield_now().await;
                release.notify_one();
            }
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert!(h.db.get_game_players("fails").is_empty());
        assert!(!h.manager.schedule.lock().unwrap().contains_key("fails"));
    }

    #[tokio::test]
    async fn an_abandoned_recovery_does_not_block_the_next_one() {
        let hang: Option<Box<dyn Fn(Arc<AtomicUsize>) -> RecoverPlayerRegistry>> = Some(Box::new(|calls| {
            Arc::new(move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                futures::future::pending().boxed()
            })
        }));
        let h = manager_with(hang, None, 0);
        track(&h, "g", &["p1"]);
        let context = game_context();
        let recovery = h.manager.try_recover_player_registry("g", &context, 2, 1);
        assert!(tokio::time::timeout(Duration::from_millis(20), recovery).await.is_err());
        // The dropped attempt released its marker, so a later completion retries.
        let recovery = h.manager.try_recover_player_registry("g", &context, 2, 1);
        assert!(tokio::time::timeout(Duration::from_millis(20), recovery).await.is_err());
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    }
}
