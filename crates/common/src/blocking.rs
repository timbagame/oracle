//! Running synchronous work (SQLite) from async code without stalling the runtime.

/// Runs `f` in place, first telling a multi-threaded tokio runtime that this
/// worker will block so its other tasks move to another worker. Outside a
/// runtime, on a current-thread runtime (tests) or on a blocking-pool thread,
/// `f` simply runs.
pub fn blocking<T>(f: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_outside_a_runtime() {
        assert_eq!(blocking(|| 1), 1);
    }

    #[tokio::test]
    async fn runs_on_a_current_thread_runtime() {
        assert_eq!(blocking(|| 2), 2);
    }

    // One worker: only `block_in_place` hands its queue to another thread.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn lets_other_tasks_run_while_blocking() {
        // The test body runs on the main thread; block from inside the runtime's only worker.
        tokio::spawn(async {
            let (sender, receiver) = std::sync::mpsc::channel();
            // Queued on this worker: it must make progress while the worker blocks.
            let other = tokio::spawn(async move { sender.send(()).unwrap() });
            blocking(|| receiver.recv_timeout(std::time::Duration::from_secs(2)).expect("other task ran"));
            other.await.unwrap();
        })
        .await
        .unwrap();
        let from_pool = tokio::task::spawn_blocking(|| blocking(|| 3)).await.unwrap();
        assert_eq!(from_pool, 3);
    }
}
