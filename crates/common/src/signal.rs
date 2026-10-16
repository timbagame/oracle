//! SIGINT/SIGTERM handling shared by both binaries: the first signal starts a
//! graceful shutdown, a second one exits at once (`process.once` handlers).

use tokio::signal::unix::{signal, Signal, SignalKind};

/// Listens for SIGTERM and SIGINT from the moment it is created.
pub struct Termination {
    term: Signal,
    int: Signal,
}

impl Termination {
    pub fn listen() -> Self {
        Self {
            term: signal(SignalKind::terminate()).expect("SIGTERM handler"),
            int: signal(SignalKind::interrupt()).expect("SIGINT handler"),
        }
    }

    /// Resolves with the name of the next signal.
    pub async fn recv(&mut self) -> &'static str {
        tokio::select! {
            _ = self.term.recv() => "SIGTERM",
            _ = self.int.recv() => "SIGINT",
        }
    }
}

/// The conventional exit code after `signal` (128 + its number).
pub fn exit_code(signal: &str) -> i32 {
    if signal == "SIGINT" {
        130
    } else {
        143
    }
}

/// Calls `first` on the first signal and exits the process on the second.
pub fn on_termination(first: impl FnOnce(&'static str) + Send + 'static) {
    let mut signals = Termination::listen();
    tokio::spawn(async move {
        first(signals.recv().await);
        let signal = signals.recv().await;
        crate::warn!("{signal} received again; exiting without waiting for shutdown");
        std::process::exit(exit_code(signal));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raise(name: &str) {
        let status = std::process::Command::new("kill")
            .args([&format!("-{name}"), &std::process::id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[tokio::test]
    async fn names_each_signal() {
        let mut signals = Termination::listen();
        raise("TERM");
        assert_eq!(signals.recv().await, "SIGTERM");
        raise("INT");
        assert_eq!(signals.recv().await, "SIGINT");
        assert_eq!(exit_code("SIGINT"), 130);
        assert_eq!(exit_code("SIGTERM"), 143);
    }
}
