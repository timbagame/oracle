//! In-memory bounded history of completion, scan and cleanup events (port of
//! `metrics.ts`).

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionOutcome {
    Success,
    NotReady,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletionRecord {
    pub game_address: String,
    pub outcome: CompletionOutcome,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScanCycleRecord {
    pub duration_ms: f64,
    pub completed: u64,
    pub errors: u64,
    pub not_ready: u64,
    pub pending: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CleanupRecord {
    pub hours_old: i64,
    pub deleted_secrets: u64,
    pub deleted_games: u64,
    pub deleted_players: u64,
}

const DEFAULT_MAX_HISTORY: usize = 500;

#[derive(Default)]
struct Buffers {
    completions: VecDeque<CompletionRecord>,
    scans: VecDeque<ScanCycleRecord>,
    cleanups: VecDeque<CleanupRecord>,
}

pub struct OracleMetrics {
    max_history: usize,
    buffers: Mutex<Buffers>,
}

impl Default for OracleMetrics {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_HISTORY)
    }
}

fn push_bounded<T>(buffer: &mut VecDeque<T>, value: T, max: usize) {
    buffer.push_back(value);
    while buffer.len() > max {
        buffer.pop_front();
    }
}

impl OracleMetrics {
    pub fn new(max_history: usize) -> Self {
        let max_history = if max_history > 0 { max_history } else { DEFAULT_MAX_HISTORY };
        Self { max_history, buffers: Mutex::new(Buffers::default()) }
    }

    pub fn global() -> &'static OracleMetrics {
        static GLOBAL: OnceLock<OracleMetrics> = OnceLock::new();
        GLOBAL.get_or_init(OracleMetrics::default)
    }

    pub fn record_completion(&self, record: CompletionRecord) {
        push_bounded(&mut self.buffers.lock().unwrap().completions, record, self.max_history);
    }

    pub fn record_scan_cycle(&self, record: ScanCycleRecord) {
        push_bounded(&mut self.buffers.lock().unwrap().scans, record, self.max_history);
    }

    pub fn record_cleanup_sweep(&self, record: CleanupRecord) {
        push_bounded(&mut self.buffers.lock().unwrap().cleanups, record, self.max_history);
    }

    pub fn reset(&self) {
        *self.buffers.lock().unwrap() = Buffers::default();
    }

    pub fn completion_records(&self) -> Vec<CompletionRecord> {
        self.buffers.lock().unwrap().completions.iter().cloned().collect()
    }

    pub fn scan_cycles(&self) -> Vec<ScanCycleRecord> {
        self.buffers.lock().unwrap().scans.iter().cloned().collect()
    }

    pub fn cleanup_sweeps(&self) -> Vec<CleanupRecord> {
        self.buffers.lock().unwrap().cleanups.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_history() {
        let metrics = OracleMetrics::new(2);
        for i in 0..3 {
            metrics.record_completion(CompletionRecord {
                game_address: i.to_string(),
                outcome: CompletionOutcome::Success,
                error: None,
            });
        }
        let records = metrics.completion_records();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].game_address, "1");
        metrics.reset();
        assert!(metrics.completion_records().is_empty());
    }

    fn scan(completed: u64) -> ScanCycleRecord {
        ScanCycleRecord { duration_ms: 1.5, completed, errors: 0, not_ready: 0, pending: 0 }
    }

    fn cleanup(deleted_games: u64) -> CleanupRecord {
        CleanupRecord { hours_old: 48, deleted_secrets: 0, deleted_games, deleted_players: 0 }
    }

    #[test]
    fn trims_scan_and_cleanup_history_independently() {
        let metrics = OracleMetrics::new(2);
        for i in 0..3 {
            metrics.record_scan_cycle(scan(i));
        }
        metrics.record_cleanup_sweep(cleanup(7));
        let scans = metrics.scan_cycles();
        assert_eq!(scans.iter().map(|s| s.completed).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(metrics.cleanup_sweeps(), vec![cleanup(7)]);
        assert!(metrics.completion_records().is_empty());
        metrics.reset();
        assert!(metrics.scan_cycles().is_empty() && metrics.cleanup_sweeps().is_empty());
    }

    #[test]
    fn a_zero_limit_falls_back_to_the_default_history_size() {
        for metrics in [OracleMetrics::new(0), OracleMetrics::default()] {
            for i in 0..(DEFAULT_MAX_HISTORY as u64 + 3) {
                metrics.record_scan_cycle(scan(i));
            }
            let scans = metrics.scan_cycles();
            assert_eq!(scans.len(), DEFAULT_MAX_HISTORY);
            assert_eq!(scans[0].completed, 3);
        }
    }

    #[test]
    fn the_global_instance_is_shared() {
        let first = OracleMetrics::global();
        let second = OracleMetrics::global();
        assert!(std::ptr::eq(first, second));
        first.record_cleanup_sweep(cleanup(424_242));
        assert!(second.cleanup_sweeps().contains(&cleanup(424_242)));
    }
}
