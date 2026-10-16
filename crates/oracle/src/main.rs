use clap::{Parser, Subcommand};

use timba_oracle::cli::{self, ExitError};

#[derive(Parser)]
#[command(name = "timba-oracle", version, about = "Timba Solana oracle")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the oracle API, event listeners and background workers (default).
    Serve,
    /// Operator actions: requeue, auto-complete, token-policy.
    Admin {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Attempt to complete one game immediately.
    AttemptCompletion { game_address: String },
    /// Print a game's on-chain state and completion readiness.
    InspectGame { game_address: String },
    /// Print the on-chain oracle account.
    InspectOracle,
    /// Audit winner randomness for a pending game.
    AuditRandom {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Drain pending games without event listeners, then clean up records.
    ManualShutdown,
}

fn main() {
    timba_common::time::mark_process_start();
    let cli = Cli::parse();
    let runtime = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");
    let result = runtime.block_on(async {
        match cli.command.unwrap_or(Command::Serve) {
            Command::Serve => timba_oracle::server::serve().await,
            Command::Admin { args } => cli::admin(&args).await.map(|()| 0),
            Command::AttemptCompletion { game_address } => cli::attempt_completion(&game_address).await.map(|()| 0),
            Command::InspectGame { game_address } => cli::inspect_game(&game_address).await.map(|()| 0),
            Command::InspectOracle => cli::inspect_oracle().await.map(|()| 0),
            Command::AuditRandom { args } => cli::audit_random::run(&args).await.map(|()| 0),
            Command::ManualShutdown => cli::manual_shutdown().await.map(|()| 0),
        }
    });
    // Background tasks (listeners, timers) must not keep the process alive.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    let code = match result {
        Ok(code) => code,
        Err(err) => match err.downcast_ref::<ExitError>() {
            Some(exit) => {
                eprintln!("{}", exit.message);
                exit.code
            }
            None => {
                eprintln!("{err:#}");
                1
            }
        },
    };
    std::process::exit(code);
}
