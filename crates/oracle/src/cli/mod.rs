//! Operator commands (ports of `scripts/*.ts`).

pub mod audit_random;

use std::io::Write;
use std::sync::Arc;

use anyhow::Context;
use futures::future::{BoxFuture, FutureExt};
use serde_json::json;
use timba_protocol::contracts::{find_oracle_pda, OracleAccount};
use timba_protocol::Address;

use crate::config::OracleConfig;
use crate::core::scan::ScanLoopSummary;
use crate::core::service::OracleService;
use crate::core::types::CompletionStats;

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

type Out<'a> = &'a mut (dyn Write + Send);

/// Runs `command` against a service built from the environment, then closes it.
async fn with_service<F>(command: F) -> anyhow::Result<()>
where
    F: for<'a> FnOnce(&'a Arc<OracleService>, Out<'a>) -> BoxFuture<'a, anyhow::Result<()>>,
{
    let config = OracleConfig::global().map_err(anyhow::Error::msg)?.clone();
    let oracle = OracleService::create(config)?;
    let result = command(&oracle, &mut std::io::stdout()).await;
    oracle.close().await;
    result
}

fn print_json(out: Out<'_>, value: &impl serde::Serialize) -> anyhow::Result<()> {
    writeln!(out, "{}", serde_json::to_string_pretty(value)?)?;
    Ok(())
}

/// `scripts/oracle-admin.ts`.
pub async fn admin(args: &[String]) -> anyhow::Result<()> {
    // Validate arguments before touching the database or RPC.
    let action = parse_admin(args)?;
    with_service(|oracle, out| run_admin(oracle, action, out).boxed()).await
}

fn parse_admin(args: &[String]) -> anyhow::Result<AdminAction> {
    let Some((command, rest)) = args.split_first() else { return Err(usage_error(ADMIN_USAGE)) };
    Ok(match (command.as_str(), rest) {
        ("requeue", [game]) => AdminAction::Requeue(game.clone()),
        ("auto-complete", [game, value]) if value == "on" || value == "off" => {
            AdminAction::AutoComplete(game.clone(), value == "off")
        }
        ("token-policy", [action]) if action == "list" => AdminAction::ListPolicies,
        ("token-policy", [action, mint, value]) if action == "set" && (value == "on" || value == "off") => {
            AdminAction::SetPolicy(mint.clone(), value == "on")
        }
        _ => return Err(usage_error(ADMIN_USAGE)),
    })
}

#[derive(Debug, PartialEq)]
enum AdminAction {
    Requeue(String),
    AutoComplete(String, bool),
    ListPolicies,
    SetPolicy(String, bool),
}

async fn run_admin(oracle: &Arc<OracleService>, action: AdminAction, out: Out<'_>) -> anyhow::Result<()> {
    match action {
        AdminAction::Requeue(game) => {
            oracle
                .requeue_game(&game)
                .map_err(|reason| anyhow::anyhow!("Unable to requeue game: {}", reason.as_str()))?;
            writeln!(out, "Requeued {game}")?;
        }
        AdminAction::AutoComplete(game, disabled) => {
            let disabled = oracle
                .set_auto_complete_disabled(&game, disabled)?
                .map_err(|reason| anyhow::anyhow!("Unable to update auto-complete: {}", reason.as_str()))?;
            writeln!(out, "Auto-complete {} for {game}", if disabled { "disabled" } else { "enabled" })?;
        }
        AdminAction::ListPolicies => print_json(out, &oracle.get_token_policies().await?)?,
        AdminAction::SetPolicy(mint, enabled) => print_json(out, &oracle.set_token_policy(&mint, enabled).await?)?,
    }
    Ok(())
}

/// `scripts/attempt-completion.ts`.
pub async fn attempt_completion(game_address: &str) -> anyhow::Result<()> {
    let game_address = game_address.to_string();
    with_service(move |oracle, out| async move { attempt(oracle, &game_address, out).await }.boxed()).await
}

async fn attempt(oracle: &Arc<OracleService>, game_address: &str, out: Out<'_>) -> anyhow::Result<()> {
    let result = oracle.complete_game_now(game_address).await.map(|r| {
        json!({
            "success": r.success,
            "notReady": r.not_ready,
            "error": r.error,
            "txHash": r.tx_hash,
            "winnerAddress": r.winner_address,
            "totalPot": r.total_pot,
        })
    });
    print_json(out, &json!({ "result": result }))
}

/// `scripts/inspect-game.ts`.
pub async fn inspect_game(address: &str) -> anyhow::Result<()> {
    let game_pda = Address::parse(address).map_err(|e| anyhow::anyhow!("Invalid game address {address}: {e}"))?;
    with_service(|oracle, out| {
        async move { inspect(oracle, &game_pda, out).await.context("Failed to inspect game") }.boxed()
    })
    .await
}

async fn inspect(oracle: &Arc<OracleService>, game_pda: &Address, out: Out<'_>) -> anyhow::Result<()> {
    let completion = oracle.completion_manager();
    let address = game_pda.to_base58();
    let Some(game) = completion.fetch_game_account(game_pda).await? else {
        return print_json(out, &json!({ "address": address, "exists": false }));
    };
    let readiness = completion.evaluate_game_readiness(game_pda, None).await?;
    print_json(
        out,
        &json!({
            "address": address,
            "exists": true,
            "ticketsCount": game.tickets_count,
            "maxTickets": game.max_tickets,
            "minTickets": game.min_tickets,
            "lastSlot": game.last_slot,
            "timeout": game.timeout,
            "createdAt": game.created_at,
            "readiness": { "ready": readiness.ready, "evaluatedAt": readiness.evaluated_at },
        }),
    )
}

/// `scripts/inspect-oracle.ts`.
pub async fn inspect_oracle() -> anyhow::Result<()> {
    with_service(|oracle, out| {
        async move { describe_oracle(oracle, out).await.context("Failed to inspect oracle") }.boxed()
    })
    .await
}

async fn describe_oracle(oracle: &Arc<OracleService>, out: Out<'_>) -> anyhow::Result<()> {
    let oracle_pda = find_oracle_pda(&oracle.program_id());
    let account = oracle
        .connection()
        .get_account_info(&oracle_pda)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Account not found at address: {oracle_pda}"))?;
    let data = OracleAccount::decode(&account.data).map_err(|e| anyhow::anyhow!("{e}"))?;
    print_json(
        out,
        &json!({
            "oracleAddress": oracle_pda.to_base58(),
            "account": {
                "operator": data.operator.to_base58(),
                "feePercentage": data.fee_percentage,
                "oracleBufferTime": data.oracle_buffer_time,
                "maxTickets": data.max_tickets,
                "maxTimeout": data.max_timeout,
                "minTimeout": data.min_timeout,
            },
        }),
    )
}

/// `scripts/manual-shutdown.ts`: drains pending games without event
/// listeners, then removes every finished record.
pub async fn manual_shutdown() -> anyhow::Result<()> {
    with_service(|oracle, out| drain(oracle, 30_000, out).boxed()).await
}

async fn drain(oracle: &Arc<OracleService>, wait_ms: u64, out: Out<'_>) -> anyhow::Result<()> {
    writeln!(out, "🛑 Timba Oracle Manual Shutdown")?;
    writeln!(out, "================================")?;
    oracle.stop_event_listening().await;

    let scanner = oracle.scan_runner().clone();
    let scan = move || {
        let scanner = scanner.clone();
        async move { scanner.scan_and_complete_active_games(None).await }.boxed()
    };
    let summary = drain_cycles(scan, wait_ms, out).await?;

    let cleanup = oracle.cleanup_old_records(0);
    writeln!(out, "\n🧹 Cleanup summary:")?;
    writeln!(
        out,
        "   Deleted secrets: {}, deleted games: {}, deleted players: {}",
        cleanup.deleted_secrets, cleanup.deleted_games, cleanup.deleted_players
    )?;
    writeln!(out, "\n✅ Manual shutdown scan complete.")?;
    writeln!(out, "   Total completions: {}, total errors: {}", summary.total_completed, summary.total_errors)?;
    Ok(())
}

/// Runs scan cycles until no game is left to wait for, pausing `wait_ms`
/// between cycles while games are not ready or only errors remain.
async fn drain_cycles<F>(mut scan: F, wait_ms: u64, out: Out<'_>) -> anyhow::Result<ScanLoopSummary>
where
    F: FnMut() -> BoxFuture<'static, CompletionStats>,
{
    let mut summary = ScanLoopSummary::default();
    // The scan loop has no per-cycle hooks; run one cycle at a time to print
    // progress like the TS callbacks did.
    loop {
        summary.cycles += 1;
        writeln!(out, "\n▶️  Scan cycle {}", summary.cycles)?;
        let stats = scan().await;
        summary.total_completed += stats.completed;
        summary.total_errors += stats.errors;
        summary.total_not_ready += stats.not_ready;
        writeln!(out, "   Completed: {}, Not Ready: {}, Errors: {}", stats.completed, stats.not_ready, stats.errors)?;
        if stats.not_ready == 0 && stats.completed == 0 {
            writeln!(out, "   No actionable games remaining.")?;
        } else if stats.not_ready > 0 {
            writeln!(out, "   Waiting {}s for remaining games to settle...", wait_ms / 1000)?;
        }
        if stats.is_empty() {
            return Ok(summary);
        }
        let only_errors = stats.errors > 0 && stats.completed == 0 && stats.not_ready == 0;
        if !only_errors && stats.not_ready == 0 {
            return Ok(summary);
        }
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
    }
}

/// Container health probe: exits non-zero unless `GET /health` on the local
/// API port succeeds. Replaces the `bun -e fetch(...)` quadlet HealthCmd.
pub async fn healthcheck() -> anyhow::Result<()> {
    probe(crate::config::oracle_port_from_env()).await
}

async fn probe(port: u16) -> anyhow::Result<()> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()?
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await?;
    anyhow::ensure!(response.status().is_success(), "Health check failed with status {}", response.status());
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum::routing::get;
    use base64::Engine;
    use serde_json::{json, Value};
    use timba_protocol::contracts::{find_oracle_pda, OracleAccount, PROGRAM_ID};

    use super::*;
    use crate::core::testing::{account_value, game_account, harness, Harness};
    use crate::solana::rpc::RpcError;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    /// Runs a command body against the harness service and returns what it printed.
    async fn printed<F>(h: &Harness, command: F) -> anyhow::Result<String>
    where
        F: for<'a> FnOnce(&'a Arc<OracleService>, Out<'a>) -> BoxFuture<'a, anyhow::Result<()>>,
    {
        let mut out = Vec::new();
        command(&h.service, &mut out).await?;
        Ok(String::from_utf8(out).unwrap())
    }

    fn tracked_game(h: &Harness) -> String {
        h.service.generate_game_secrets(None).unwrap().game_address
    }

    #[test]
    fn parses_admin_commands_and_rejects_anything_else() {
        let game = "game".to_string();
        assert_eq!(parse_admin(&args(&["requeue", "game"])).unwrap(), AdminAction::Requeue(game.clone()));
        assert_eq!(
            parse_admin(&args(&["auto-complete", "game", "off"])).unwrap(),
            AdminAction::AutoComplete(game.clone(), true)
        );
        assert_eq!(
            parse_admin(&args(&["auto-complete", "game", "on"])).unwrap(),
            AdminAction::AutoComplete(game, false)
        );
        assert_eq!(parse_admin(&args(&["token-policy", "list"])).unwrap(), AdminAction::ListPolicies);
        assert_eq!(
            parse_admin(&args(&["token-policy", "set", "mint", "on"])).unwrap(),
            AdminAction::SetPolicy("mint".into(), true)
        );
        for bad in [
            &[][..],
            &["requeue"],
            &["auto-complete", "game", "maybe"],
            &["token-policy", "show"],
            &["token-policy", "set", "mint", "yes"],
            &["unknown"],
        ] {
            let err = parse_admin(&args(bad)).unwrap_err();
            let exit = err.downcast_ref::<ExitError>().unwrap();
            assert_eq!((exit.code, exit.message.as_str()), (2, ADMIN_USAGE), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn admin_actions_update_the_database_and_report_back() {
        let h = harness();
        let game = tracked_game(&h);
        let run = |action| printed(&h, move |oracle, out| run_admin(oracle, action, out).boxed());

        assert_eq!(run(AdminAction::Requeue(game.clone())).await.unwrap(), format!("Requeued {game}\n"));
        let err = run(AdminAction::Requeue("unknown".into())).await.unwrap_err();
        assert_eq!(err.to_string(), "Unable to requeue game: not-found");

        let off = run(AdminAction::AutoComplete(game.clone(), true)).await.unwrap();
        assert_eq!(off, format!("Auto-complete disabled for {game}\n"));
        assert!(h.service.db().get_completion_attempt_state(&game).unwrap().auto_complete_disabled);
        let on = run(AdminAction::AutoComplete(game.clone(), false)).await.unwrap();
        assert_eq!(on, format!("Auto-complete enabled for {game}\n"));
        let err = run(AdminAction::AutoComplete("unknown".into(), true)).await.unwrap_err();
        assert!(err.to_string().starts_with("Unable to update auto-complete: "), "{err}");

        let mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let set: Value = serde_json::from_str(&run(AdminAction::SetPolicy(mint.into(), false)).await.unwrap()).unwrap();
        assert_eq!((set["mint"].as_str(), set["enabled"].as_bool()), (Some(mint), Some(false)));
        let listed = run(AdminAction::ListPolicies).await.unwrap();
        assert!(serde_json::from_str::<Value>(&listed).unwrap().is_array(), "{listed}");
        let err = run(AdminAction::SetPolicy("not a mint".into(), false)).await.unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    #[tokio::test]
    async fn attempting_a_completion_prints_the_outcome() {
        let h = harness();
        let game = tracked_game(&h);
        h.transport.on(|_, method, _| {
            (method == "getAccountInfo").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });
        let address = game.clone();
        let output = printed(&h, move |oracle, out| async move { attempt(oracle, &address, out).await }.boxed());
        let output: Value = serde_json::from_str(&output.await.unwrap()).unwrap();
        let result = &output["result"];
        assert_eq!((result["success"].as_bool(), result["notReady"].as_bool()), (Some(false), Some(false)));
        assert!(result["error"].as_str().unwrap().contains("connection reset"), "{output}");
        assert!(result["txHash"].is_null() && result["winnerAddress"].is_null(), "{output}");
    }

    #[tokio::test]
    async fn inspects_missing_and_existing_games() {
        let h = harness();
        let pda = Address([5; 32]);
        h.transport.push("getAccountInfo", Ok(json!({ "value": null })));
        let missing = printed(&h, |oracle, out| async move { inspect(oracle, &pda, out).await }.boxed()).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&missing).unwrap(),
            json!({ "address": pda.to_base58(), "exists": false })
        );

        let game = game_account(2, 10, 2, 1_700_000_000, 600);
        let value = account_value(&game);
        h.transport.on(move |_, method, _| match method {
            "getAccountInfo" => Some(Ok(value.clone())),
            "getSlot" => Some(Ok(json!(200))),
            "getBlockTime" => Some(Ok(json!(1_700_000_100))),
            _ => None,
        });
        let found = printed(&h, |oracle, out| async move { inspect(oracle, &pda, out).await }.boxed()).await.unwrap();
        let found: Value = serde_json::from_str(&found).unwrap();
        assert_eq!(found["exists"], true);
        assert_eq!((found["ticketsCount"].as_u64(), found["maxTickets"].as_u64()), (Some(2), Some(10)));
        assert_eq!(found["lastSlot"].as_u64(), Some(game.last_slot));
        assert!(found["readiness"]["ready"].is_boolean(), "{found}");
    }

    #[tokio::test]
    async fn describes_the_oracle_account() {
        let h = harness();
        let oracle_pda = find_oracle_pda(&PROGRAM_ID);
        let account = OracleAccount {
            operator: Address([3; 32]),
            fee_percentage: 5,
            oracle_buffer_time: 30,
            max_tickets: 100,
            max_timeout: 86_400,
            min_timeout: 60,
        };
        let encoded = |data: Vec<u8>| {
            json!({ "value": {
                "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
                "owner": PROGRAM_ID.to_base58(), "lamports": 1, "executable": false,
            }})
        };
        h.transport.push("getAccountInfo", Ok(encoded(account.encode())));
        let printed_account = printed(&h, |oracle, out| describe_oracle(oracle, out).boxed()).await.unwrap();
        let printed_account: Value = serde_json::from_str(&printed_account).unwrap();
        assert_eq!(printed_account["oracleAddress"], oracle_pda.to_base58());
        assert_eq!(
            printed_account["account"],
            json!({ "operator": Address([3; 32]).to_base58(), "feePercentage": 5, "oracleBufferTime": 30,
                    "maxTickets": 100, "maxTimeout": 86_400, "minTimeout": 60 })
        );

        h.transport.push("getAccountInfo", Ok(encoded(vec![0; 8])));
        let err = printed(&h, |oracle, out| describe_oracle(oracle, out).boxed()).await.unwrap_err();
        assert_eq!(err.to_string(), "Account is not a Timba oracle");
        h.transport.push("getAccountInfo", Ok(json!({ "value": null })));
        let err = printed(&h, |oracle, out| describe_oracle(oracle, out).boxed()).await.unwrap_err();
        assert_eq!(err.to_string(), format!("Account not found at address: {oracle_pda}"));
    }

    fn stats(completed: u64, not_ready: u64, errors: u64) -> CompletionStats {
        CompletionStats { completed, errors, not_ready }
    }

    #[tokio::test(start_paused = true)]
    async fn draining_waits_while_games_are_not_ready_or_failing() {
        let mut cycles = vec![stats(0, 2, 0), stats(0, 0, 1), stats(1, 1, 0), stats(3, 0, 1)].into_iter();
        let scan = move || futures::future::ready(cycles.next().unwrap()).boxed();
        let mut out = Vec::new();
        let started = tokio::time::Instant::now();
        let summary = drain_cycles(scan, 30_000, &mut out).await.unwrap();
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(90), "waited after each of the first three");
        assert_eq!((summary.cycles, summary.total_completed, summary.total_errors), (4, 4, 2));
        assert_eq!(summary.total_not_ready, 3);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("Waiting 30s for remaining games to settle...").count(), 2, "{text}");
        assert_eq!(text.matches("No actionable games remaining.").count(), 1, "{text}");
        assert!(text.ends_with("Completed: 3, Not Ready: 0, Errors: 1\n"), "{text}");
    }

    #[tokio::test]
    async fn manual_shutdown_cleans_up_once_nothing_is_pending() {
        let h = harness();
        let mut out = Vec::new();
        drain(&h.service, 0, &mut out).await.unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("🛑 Timba Oracle Manual Shutdown\n"), "{text}");
        assert!(
            text.contains("Scan cycle 1\n   Completed: 0, Not Ready: 0, Errors: 0\n   No actionable games remaining.")
        );
        assert!(text.ends_with("Total completions: 0, total errors: 0\n"), "{text}");
    }

    /// A writer that breaks (a closed pipe, say) after `allowed` writes.
    struct BrokenPipe {
        allowed: usize,
    }

    impl std::io::Write for BrokenPipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.allowed == 0 {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            self.allowed -= 1;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn manual_shutdown_stops_when_the_output_breaks() {
        let h = harness();
        let mut failures = 0;
        // Break the output after every possible number of writes, up to a complete run.
        for allowed in 0.. {
            match drain(&h.service, 0, &mut BrokenPipe { allowed }).await {
                Ok(()) => break,
                Err(err) => {
                    assert_eq!(err.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::BrokenPipe);
                    failures += 1;
                }
            }
        }
        assert!(failures > 10, "every write is checked: {failures}");
    }

    async fn health_server(status: StatusCode) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route("/health", get(move || async move { status }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    #[tokio::test]
    async fn healthcheck_probes_the_configured_port() {
        let healthy = health_server(StatusCode::OK).await;
        let degraded = health_server(StatusCode::SERVICE_UNAVAILABLE).await;
        let port_for = |value: String| {
            let _env = crate::env_test_lock();
            let saved = std::env::var("ORACLE_PORT").ok();
            std::env::set_var("ORACLE_PORT", value);
            let port = crate::config::oracle_port_from_env();
            match saved {
                Some(value) => std::env::set_var("ORACLE_PORT", value),
                None => std::env::remove_var("ORACLE_PORT"),
            }
            port
        };
        // Parsed like `serve` does (JavaScript `Number`), so "3001.0" is port 3001.
        let ok = super::probe(port_for(format!(" {healthy}.0 "))).await;
        let failed = super::probe(port_for(degraded.to_string())).await;
        ok.unwrap();
        assert_eq!(failed.unwrap_err().to_string(), "Health check failed with status 503 Service Unavailable");
    }
}
