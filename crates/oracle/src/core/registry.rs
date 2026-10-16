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
                            let logs = transaction.map(|t| t.log_messages).unwrap_or_default();
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
            collected.extend(page.into_iter().map(|s| (s.signature, s.slot)));
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
        let request = RecoverRequest {
            game_address: game_address.to_string(),
            context: context.clone(),
            expected_tickets: expected_entries,
            reason: "completion",
        };
        let outcome = recover(request).await;
        self.attempted_recovery.lock().unwrap().remove(game_address);
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
}
