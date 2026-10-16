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
}
