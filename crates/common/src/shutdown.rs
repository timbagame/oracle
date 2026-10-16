//! Cooperative cancellation (the Rust stand-in for `AbortSignal`).

use std::time::Duration;

use tokio::sync::watch;

#[derive(Clone)]
pub struct Shutdown {
    tx: watch::Sender<bool>,
    rx: watch::Receiver<bool>,
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}

impl Shutdown {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self { tx, rx }
    }

    pub fn trigger(&self) {
        let _ = self.tx.send(true);
    }

    pub fn is_triggered(&self) -> bool {
        *self.rx.borrow()
    }

    pub async fn wait(&self) {
        let mut rx = self.rx.clone();
        let _ = rx.wait_for(|v| *v).await;
    }

    /// Sleeps for `ms` or until shutdown, whichever comes first.
    pub async fn sleep(&self, ms: u64) {
        if ms == 0 || self.is_triggered() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
            _ = self.wait() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn sleeps_until_the_deadline_or_the_trigger() {
        let shutdown = Shutdown::default();
        assert!(!shutdown.is_triggered());
        let started = tokio::time::Instant::now();
        shutdown.sleep(0).await;
        shutdown.sleep(50).await;
        assert_eq!(started.elapsed(), Duration::from_millis(50));

        let trigger = shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.trigger();
        });
        shutdown.sleep(60_000).await;
        assert_eq!(started.elapsed(), Duration::from_millis(60));
        shutdown.wait().await;
        shutdown.sleep(60_000).await;
        assert_eq!(started.elapsed(), Duration::from_millis(60));
    }
}
