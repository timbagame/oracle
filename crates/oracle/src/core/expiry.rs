//! Wake-ups at game expiry. A game with its minimum players becomes ready once its
//! timeout passes, and no program event announces that, so without a timer it waited
//! for the next fallback scan (up to five minutes).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::future::BoxFuture;
use timba_protocol::contracts::GameAccount;
use timba_protocol::Address;
use tokio::task::JoinHandle;

/// Wall-clock margin past the on-chain expiry, so the chain clock has passed it too.
pub const EXPIRY_GRACE_MS: i64 = 1_000;
/// Shortest wait, so a lagging chain clock is rechecked once a second, not in a loop.
pub const MIN_EXPIRY_DELAY_MS: i64 = 1_000;

/// Runs when a scheduled game expires: `(game address, game key)`.
pub type ExpiryCallback = Arc<dyn Fn(String, Address) -> BoxFuture<'static, ()> + Send + Sync>;

/// The on-chain time (unix seconds) at which a not yet ready game becomes ready by
/// expiring: it has its minimum players, is not full, and has not expired at `evaluated_at`.
pub fn expiry_wakeup(game: &GameAccount, evaluated_at: i64) -> Option<i64> {
    let expires_at = i64::try_from(game.created_at.checked_add(game.timeout)?).ok()?;
    let tickets = game.tickets_count;
    let has_min = tickets > 0 && tickets >= game.min_tickets;
    (has_min && tickets < game.max_tickets && evaluated_at < expires_at).then_some(expires_at)
}

struct Timer {
    expires_at: i64,
    id: u64,
    handle: JoinHandle<()>,
}

#[derive(Default)]
pub struct ExpiryTimers {
    timers: Mutex<HashMap<String, Timer>>,
    next_id: Mutex<u64>,
    callback: OnceLock<ExpiryCallback>,
}

impl ExpiryTimers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Sets what runs at expiry; later calls are ignored.
    pub fn set_callback(&self, callback: ExpiryCallback) {
        let _ = self.callback.set(callback);
    }

    /// Wakes the callback once `expires_at` (on-chain unix seconds) has passed. A game
    /// keeps one timer: the same deadline is a no-op, a new one replaces it.
    pub fn schedule(self: &Arc<Self>, game_address: &str, game_key: Address, expires_at: i64) {
        let mut timers = self.timers.lock().unwrap();
        if timers.get(game_address).is_some_and(|timer| timer.expires_at == expires_at) {
            return;
        }
        let id = {
            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            *next
        };
        let now = timba_common::time::now_ms();
        let delay = (expires_at.saturating_mul(1000) + EXPIRY_GRACE_MS - now).max(MIN_EXPIRY_DELAY_MS);
        let this = Arc::downgrade(self);
        let address = game_address.to_string();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            let Some(this) = this.upgrade() else { return };
            // A replaced or cancelled timer is aborted, but it may already be past its sleep.
            let current = {
                let mut timers = this.timers.lock().unwrap();
                let current = timers.get(&address).is_some_and(|timer| timer.id == id);
                if current {
                    timers.remove(&address);
                }
                current
            };
            if let (true, Some(callback)) = (current, this.callback.get()) {
                callback(address, game_key).await;
            }
        });
        if let Some(previous) = timers.insert(game_address.to_string(), Timer { expires_at, id, handle }) {
            previous.handle.abort();
        }
    }

    pub fn cancel(&self, game_address: &str) {
        if let Some(timer) = self.timers.lock().unwrap().remove(game_address) {
            timer.handle.abort();
        }
    }

    pub fn clear(&self) {
        for (_, timer) in self.timers.lock().unwrap().drain() {
            timer.handle.abort();
        }
    }

    /// The deadline scheduled for a game, if any.
    pub fn scheduled(&self, game_address: &str) -> Option<i64> {
        self.timers.lock().unwrap().get(game_address).map(|timer| timer.expires_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::game_account;
    use futures::FutureExt;
    use tokio::sync::mpsc;

    fn recorder() -> (Arc<ExpiryTimers>, mpsc::UnboundedReceiver<(String, Address)>) {
        let timers = ExpiryTimers::new();
        let (sender, receiver) = mpsc::unbounded_channel();
        timers.set_callback(Arc::new(move |game, key| {
            let _ = sender.send((game, key));
            async {}.boxed()
        }));
        (timers, receiver)
    }

    #[test]
    fn wakes_games_that_will_be_ready_at_expiry() {
        // game_account(tickets, max, min, created_at, timeout)
        let game = |tickets, max, min| game_account(tickets, max, min, 1_000, 60);
        assert_eq!(expiry_wakeup(&game(1, 10, 1), 1_059), Some(1_060));
        assert_eq!(expiry_wakeup(&game(3, 10, 3), 1_000), Some(1_060));
        // Already expired, still short of the minimum, empty, or full: nothing to wait for.
        assert_eq!(expiry_wakeup(&game(1, 10, 1), 1_060), None);
        assert_eq!(expiry_wakeup(&game(2, 10, 3), 1_000), None);
        assert_eq!(expiry_wakeup(&game(0, 10, 0), 1_000), None);
        assert_eq!(expiry_wakeup(&game(10, 10, 1), 1_000), None);
        assert_eq!(expiry_wakeup(&game_account(1, 10, 1, u64::MAX, 60), 0), None);
        assert_eq!(expiry_wakeup(&game_account(1, 10, 1, u64::MAX - 10, 5), 0), None);
    }

    #[tokio::test(start_paused = true)]
    async fn fires_once_after_the_deadline_plus_grace() {
        let (timers, mut fired) = recorder();
        let key = Address([5; 32]);
        let expires_at = timba_common::time::now_secs() + 30;
        timers.schedule("game", key, expires_at);
        timers.schedule("game", key, expires_at);
        assert_eq!(timers.scheduled("game"), Some(expires_at));
        let started = tokio::time::Instant::now();
        assert_eq!(fired.recv().await.unwrap(), ("game".to_string(), key));
        let waited = started.elapsed().as_millis() as i64;
        assert!((29_000..=31_000 + EXPIRY_GRACE_MS).contains(&waited), "waited {waited}ms");
        assert_eq!(timers.scheduled("game"), None);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(fired.try_recv().is_err(), "a deadline fires once");
    }

    #[tokio::test(start_paused = true)]
    async fn past_deadlines_wait_a_second_and_new_deadlines_replace_old_ones() {
        let (timers, mut fired) = recorder();
        let now = timba_common::time::now_secs();
        timers.schedule("late", Address([1; 32]), now - 100);
        timers.schedule("moved", Address([2; 32]), now + 5);
        timers.schedule("moved", Address([2; 32]), now + 500);
        let started = tokio::time::Instant::now();
        assert_eq!(fired.recv().await.unwrap().0, "late");
        assert_eq!(started.elapsed().as_millis() as i64, MIN_EXPIRY_DELAY_MS);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(fired.try_recv().is_err(), "the replaced deadline never fires");
        assert_eq!(timers.scheduled("moved"), Some(now + 500));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_and_cleared_timers_never_fire() {
        let (timers, mut fired) = recorder();
        let now = timba_common::time::now_secs();
        timers.schedule("a", Address([1; 32]), now + 5);
        timers.schedule("b", Address([2; 32]), now + 5);
        timers.schedule("c", Address([3; 32]), now + 5);
        timers.cancel("a");
        timers.cancel("missing");
        timers.clear();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(fired.try_recv().is_err());
        assert_eq!(timers.scheduled("b"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn timers_without_a_callback_or_owner_do_nothing() {
        let timers = ExpiryTimers::new();
        timers.schedule("a", Address([1; 32]), 0);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(timers.scheduled("a"), None, "a fired timer without a callback still clears itself");
        timers.schedule("b", Address([2; 32]), 0);
        drop(timers);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
