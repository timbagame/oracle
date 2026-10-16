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
