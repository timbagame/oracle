//! Operator commands (ports of `scripts/*.ts`).

pub mod audit_random;

use std::sync::Arc;

use anyhow::Context;
use serde_json::json;
use timba_protocol::contracts::{find_oracle_pda, OracleAccount};
use timba_protocol::Address;

use crate::config::OracleConfig;
use crate::core::service::OracleService;

pub const ADMIN_USAGE: &str = "Usage:\n  timba-oracle admin requeue <game-address>\n  timba-oracle admin auto-complete <game-address> <on|off>\n  timba-oracle admin token-policy list\n  timba-oracle admin token-policy set <mint> <on|off>";

/// Error carrying a process exit code (usage errors exit with 2).
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ExitError {
    pub code: i32,
    pub message: String,
}

fn usage_error(usage: &str) -> anyhow::Error {
    ExitError { code: 2, message: usage.to_string() }.into()
}

fn load_service() -> anyhow::Result<Arc<OracleService>> {
    let config = OracleConfig::global().map_err(anyhow::Error::msg)?.clone();
    OracleService::create(config)
}

fn print_json(value: &impl serde::Serialize) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

/// `scripts/oracle-admin.ts`.
pub async fn admin(args: &[String]) -> anyhow::Result<()> {
    let Some((command, rest)) = args.split_first() else { return Err(usage_error(ADMIN_USAGE)) };
    // Validate arguments before touching the database or RPC.
    let action = match (command.as_str(), rest) {
        ("requeue", [game]) => AdminAction::Requeue(game.clone()),
        ("auto-complete", [game, value]) if value == "on" || value == "off" => {
            AdminAction::AutoComplete(game.clone(), value == "off")
        }
        ("token-policy", [action]) if action == "list" => AdminAction::ListPolicies,
        ("token-policy", [action, mint, value]) if action == "set" && (value == "on" || value == "off") => {
            AdminAction::SetPolicy(mint.clone(), value == "on")
        }
        _ => return Err(usage_error(ADMIN_USAGE)),
    };
    let oracle = load_service()?;
    let result = run_admin(&oracle, action).await;
    oracle.close().await;
    result
}

enum AdminAction {
    Requeue(String),
    AutoComplete(String, bool),
    ListPolicies,
    SetPolicy(String, bool),
}

async fn run_admin(oracle: &Arc<OracleService>, action: AdminAction) -> anyhow::Result<()> {
    match action {
        AdminAction::Requeue(game) => {
            oracle
                .requeue_game(&game)
                .map_err(|reason| anyhow::anyhow!("Unable to requeue game: {}", reason.as_str()))?;
            println!("Requeued {game}");
        }
        AdminAction::AutoComplete(game, disabled) => {
            let disabled = oracle
                .set_auto_complete_disabled(&game, disabled)?
                .map_err(|reason| anyhow::anyhow!("Unable to update auto-complete: {}", reason.as_str()))?;
            println!("Auto-complete {} for {game}", if disabled { "disabled" } else { "enabled" });
        }
        AdminAction::ListPolicies => print_json(&oracle.get_token_policies().await?)?,
        AdminAction::SetPolicy(mint, enabled) => print_json(&oracle.set_token_policy(&mint, enabled).await?)?,
    }
    Ok(())
}

/// `scripts/attempt-completion.ts`.
pub async fn attempt_completion(game_address: &str) -> anyhow::Result<()> {
    let oracle = load_service()?;
    let result = oracle.complete_game_now(game_address).await;
    let result = result.map(|r| {
        json!({
            "success": r.success,
            "notReady": r.not_ready,
            "error": r.error,
            "txHash": r.tx_hash,
            "winnerAddress": r.winner_address,
            "totalPot": r.total_pot,
        })
    });
    print_json(&json!({ "result": result }))?;
    oracle.close().await;
    Ok(())
}

/// `scripts/inspect-game.ts`.
pub async fn inspect_game(address: &str) -> anyhow::Result<()> {
    let game_pda = Address::parse(address).map_err(|e| anyhow::anyhow!("Invalid game address {address}: {e}"))?;
    let oracle = load_service()?;
    let completion = oracle.completion_manager().clone();
    let result = async {
        let Some(game) = completion.fetch_game_account(&game_pda).await? else {
            return print_json(&json!({ "address": address, "exists": false }));
        };
        let readiness = completion.evaluate_game_readiness(&game_pda, None).await?;
        print_json(&json!({
            "address": address,
            "exists": true,
            "ticketsCount": game.tickets_count,
            "maxTickets": game.max_tickets,
            "minTickets": game.min_tickets,
            "lastSlot": game.last_slot,
            "timeout": game.timeout,
            "createdAt": game.created_at,
            "readiness": { "ready": readiness.ready, "evaluatedAt": readiness.evaluated_at },
        }))
    }
    .await;
    oracle.close().await;
    result.context("Failed to inspect game")
}

/// `scripts/inspect-oracle.ts`.
pub async fn inspect_oracle() -> anyhow::Result<()> {
    let oracle = load_service()?;
    let result = async {
        let oracle_pda = find_oracle_pda(&oracle.program_id());
        let account = oracle
            .connection()
            .get_account_info(&oracle_pda)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Account not found at address: {oracle_pda}"))?;
        let data = OracleAccount::decode(&account.data).map_err(|e| anyhow::anyhow!("{e}"))?;
        print_json(&json!({
            "oracleAddress": oracle_pda.to_base58(),
            "account": {
                "operator": data.operator.to_base58(),
                "feePercentage": data.fee_percentage,
                "oracleBufferTime": data.oracle_buffer_time,
                "maxTickets": data.max_tickets,
                "maxTimeout": data.max_timeout,
                "minTimeout": data.min_timeout,
            },
        }))
    }
    .await;
    oracle.close().await;
    result.context("Failed to inspect oracle")
}

/// `scripts/manual-shutdown.ts`: drains pending games without event
/// listeners, then removes every finished record.
pub async fn manual_shutdown() -> anyhow::Result<()> {
    println!("🛑 Timba Oracle Manual Shutdown");
    println!("================================");
    let oracle = load_service()?;
    oracle.stop_event_listening().await;

    const WAIT_MS: u64 = 30_000;
    let mut summary = crate::core::scan::ScanLoopSummary::default();
    let scanner = oracle.scan_runner().clone();
    // The scan loop has no per-cycle hooks; run one cycle at a time to print
    // progress like the TS callbacks did.
    loop {
        summary.cycles += 1;
        println!("\n▶️  Scan cycle {}", summary.cycles);
        let stats = scanner.scan_and_complete_active_games(None).await;
        summary.total_completed += stats.completed;
        summary.total_errors += stats.errors;
        summary.total_not_ready += stats.not_ready;
        println!("   Completed: {}, Not Ready: {}, Errors: {}", stats.completed, stats.not_ready, stats.errors);
        if stats.not_ready == 0 && stats.completed == 0 {
            println!("   No actionable games remaining.");
        } else if stats.not_ready > 0 {
            println!("   Waiting {}s for remaining games to settle...", WAIT_MS / 1000);
        }
        if stats.is_empty() {
            break;
        }
        let only_errors = stats.errors > 0 && stats.completed == 0 && stats.not_ready == 0;
        if !only_errors && stats.not_ready == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(WAIT_MS)).await;
    }

    let cleanup = oracle.cleanup_old_records(0);
    println!("\n🧹 Cleanup summary:");
    println!(
        "   Deleted secrets: {}, deleted games: {}, deleted players: {}",
        cleanup.deleted_secrets, cleanup.deleted_games, cleanup.deleted_players
    );
    println!("\n✅ Manual shutdown scan complete.");
    println!("   Total completions: {}, total errors: {}", summary.total_completed, summary.total_errors);
    oracle.close().await;
    Ok(())
}

/// Container health probe: exits non-zero unless `GET /health` on the local
/// API port succeeds. Replaces the `bun -e fetch(...)` quadlet HealthCmd.
pub async fn healthcheck() -> anyhow::Result<()> {
    let port = std::env::var("ORACLE_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(crate::config::DEFAULT_ORACLE_PORT);
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()?
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await?;
    anyhow::ensure!(response.status().is_success(), "Health check failed with status {}", response.status());
    Ok(())
}
