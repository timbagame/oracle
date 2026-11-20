//! Core oracle: completion, event processing, scanning and signing.

pub mod completion;
pub mod events;
pub mod expiry;
pub mod registry;
pub mod scan;
pub mod service;
pub mod signer;
#[cfg(test)]
pub mod signer_scenarios;
#[cfg(test)]
pub mod testing;
pub mod types;

/// Aborts a timer unless it is the task currently running (a fired timer
/// clearing itself must not cancel its own continuation).
fn cancel_timer(timer: Option<tokio::task::JoinHandle<()>>) {
    if let Some(timer) = timer {
        if tokio::task::try_id() != Some(timer.id()) {
            timer.abort();
        }
    }
}
