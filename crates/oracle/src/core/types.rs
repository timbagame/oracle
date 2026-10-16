//! Shared completion types (port of `oracle-service.types.ts`).

use timba_protocol::contracts::GameAccount;
use timba_protocol::Address;

use crate::db::SecretKeyData;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompletionResult {
    pub success: bool,
    pub not_ready: bool,
    pub error: Option<String>,
    pub tx_hash: Option<String>,
    pub winner_address: Option<String>,
    pub total_pot: Option<u64>,
}

impl CompletionResult {
    pub fn not_ready() -> Self {
        Self { not_ready: true, ..Self::default() }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self { error: Some(error.into()), ..Self::default() }
    }

    pub fn not_ready_with(error: impl Into<String>) -> Self {
        Self { not_ready: true, error: Some(error.into()), ..Self::default() }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompletionStats {
    pub completed: u64,
    pub errors: u64,
    pub not_ready: u64,
}

impl CompletionStats {
    pub fn is_empty(&self) -> bool {
        self.completed == 0 && self.errors == 0 && self.not_ready == 0
    }
}

/// Port of `formatCompletionStats`.
pub fn format_completion_stats(stats: &CompletionStats) -> String {
    let mut parts = Vec::new();
    if stats.completed > 0 {
        parts.push(format!("{} completed", stats.completed));
    }
    if stats.errors > 0 {
        parts.push(format!("{} errors", stats.errors));
    }
    if stats.not_ready > 0 {
        parts.push(format!("{} not ready", stats.not_ready));
    }
    parts.join(", ")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Readiness {
    pub ready: bool,
    pub game_account: Option<GameAccount>,
    pub evaluated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GameContext {
    pub game_pda: Address,
    pub secret: SecretKeyData,
    pub random_hash: [u8; 32],
    pub readiness: Option<Readiness>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReadinessResolution {
    MissingContext,
    Resolved { ready: bool, context: GameContext, readiness: Readiness, prefetch_scheduled: bool },
}

pub type LogFn = std::sync::Arc<dyn Fn(&str, Option<&str>) -> String + Send + Sync>;
pub type ResultHook = std::sync::Arc<dyn Fn(&CompletionResult) + Send + Sync>;

/// Port of `AttemptGameCompletionOptions`.
#[derive(Clone, Default)]
pub struct AttemptOptions {
    pub game_address: String,
    pub game_key: Option<Address>,
    pub context: Option<GameContext>,
    pub readiness: Option<Readiness>,
    pub skip_readiness_check: bool,
    pub on_result: Option<ResultHook>,
    pub success_log: Option<LogFn>,
    pub failure_log: Option<LogFn>,
}

impl AttemptOptions {
    pub fn new(game_address: impl Into<String>) -> Self {
        Self { game_address: game_address.into(), ..Self::default() }
    }

    pub fn logs(
        mut self,
        success: impl Fn(&str) -> String + Send + Sync + 'static,
        failure: impl Fn(&str, Option<&str>) -> String + Send + Sync + 'static,
    ) -> Self {
        self.success_log = Some(std::sync::Arc::new(move |address, _| success(address)));
        self.failure_log = Some(std::sync::Arc::new(failure));
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_stats() {
        assert_eq!(format_completion_stats(&CompletionStats::default()), "");
        assert_eq!(
            format_completion_stats(&CompletionStats { completed: 1, errors: 2, not_ready: 3 }),
            "1 completed, 2 errors, 3 not ready"
        );
    }
}
