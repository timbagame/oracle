//! Live randomness audit for one oracle-issued game
//! (port of `scripts/audit-random.ts`).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::FutureExt;
use timba_protocol::contracts::GameAccount;
use timba_protocol::Address;

use super::Out;
use crate::core::service::OracleService;
use crate::db::{OracleDatabase, PlayerMutation};
use crate::indexed_events::MembershipKind;
use crate::program_client::{is_account_missing_error, EventCallback, EventName, ProgramDispatch};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub game_address: Option<String>,
    pub interval_ms: u64,
    pub lookahead_slots: u64,
    pub once: bool,
    pub listen: bool,
    pub refresh_from_db_each_tick: bool,
    pub write_db: bool,
    pub with_block_time: bool,
}

type Input<'a> = &'a mut (dyn BufRead + Send);

pub fn parse_args(argv: &[String]) -> anyhow::Result<CliOptions> {
    let mut options = CliOptions {
        game_address: None,
        interval_ms: 2500,
        lookahead_slots: 50,
        once: false,
        listen: true,
        refresh_from_db_each_tick: false,
        write_db: false,
        with_block_time: false,
    };
    let mut positionals = Vec::new();
    let mut args = argv.iter();
    while let Some(arg) = args.next() {
        if arg.is_empty() {
            continue;
        }
        if !arg.starts_with("--") {
            positionals.push(arg.clone());
            continue;
        }
        let mut value = |flag: &str| args.next().cloned().ok_or_else(|| anyhow::anyhow!("Missing value for {flag}"));
        match arg.as_str() {
            "--once" => options.once = true,
            "--no-listen" => options.listen = false,
            "--db-refresh" => options.refresh_from_db_each_tick = true,
            "--no-db-refresh" => options.refresh_from_db_each_tick = false,
            "--write-db" => options.write_db = true,
            "--with-block-time" => options.with_block_time = true,
            "--interval" => {
                let parsed: f64 = value("--interval")?.parse().unwrap_or(f64::NAN);
                if !parsed.is_finite() || parsed < 100.0 {
                    anyhow::bail!("--interval must be a number >= 100 (ms)");
                }
                options.interval_ms = parsed as u64;
            }
            "--slots" => {
                let parsed: f64 = value("--slots")?.parse().unwrap_or(f64::NAN);
                if !parsed.is_finite() || !(1.0..=500.0).contains(&parsed) {
                    anyhow::bail!("--slots must be a number between 1 and 500");
                }
                options.lookahead_slots = parsed as u64;
            }
            "--game" => options.game_address = Some(value("--game")?),
            other => anyhow::bail!("Unknown argument: {other}"),
        }
    }
    if options.game_address.is_none() {
        options.game_address = positionals.into_iter().next();
    }
    Ok(options)
}

pub fn apply_mutation_to_players_cache(cache: &mut Vec<Option<String>>, mutation: &PlayerMutation) {
    let (index, value) = match mutation {
        PlayerMutation::Joined { player_address, ticket_index } => (*ticket_index, Some(player_address.clone())),
        PlayerMutation::Unjoined { ticket_index, moved_participant } => (*ticket_index, moved_participant.clone()),
    };
    let Ok(index) = usize::try_from(index) else { return };
    if cache.len() <= index {
        cache.resize(index + 1, None);
    }
    cache[index] = value;
}

pub fn materialize_players_cache(cache: &[Option<String>]) -> Vec<String> {
    cache.iter().flatten().cloned().collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct WinProbability {
    pub position: usize,
    pub wins: u64,
    pub total: u64,
    pub probability: f64,
    pub player_label: String,
}

pub fn calculate_win_probabilities(
    win_counts: &HashMap<usize, u64>,
    total_slots: u64,
    players: &[String],
) -> Vec<WinProbability> {
    (0..=players.len())
        .map(|i| {
            let wins = win_counts.get(&i).copied().unwrap_or(0);
            WinProbability {
                position: i + 1,
                wins,
                total: total_slots,
                probability: wins as f64 / total_slots as f64 * 100.0,
                player_label: if i == players.len() { "<new join>".into() } else { players[i].clone() },
            }
        })
        .collect()
}

pub fn format_player_label(label: &str, max_length: usize) -> String {
    let chars: Vec<char> = label.chars().collect();
    if chars.len() <= max_length {
        return label.to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}...{tail}")
}

fn format_unix_seconds(seconds: Option<i64>) -> String {
    match seconds {
        Some(s) if s > 0 => timba_common::time::iso_from_ms(s * 1000),
        _ => "n/a".into(),
    }
}

fn compute_winner_display(tickets_count: u32, players: &[String], winner_index: u32) -> String {
    if tickets_count == 0 || players.is_empty() {
        return "n/a (no players)".into();
    }
    match players.get(winner_index as usize) {
        Some(winner) => format!("{winner} (index={winner_index}, position={})", winner_index + 1),
        None => format!("index={winner_index} (missing player)"),
    }
}

fn prompt_select_game(db: &OracleDatabase, input: Input<'_>, out: Out<'_>) -> anyhow::Result<String> {
    let pending = db.get_pending_games(None);
    let mut read = |out: &mut Out<'_>, question: &str| -> anyhow::Result<String> {
        write!(out, "{question}")?;
        out.flush()?;
        let mut line = String::new();
        input.read_line(&mut line)?;
        Ok(line.trim().to_string())
    };
    let mut out = out;
    if pending.is_empty() {
        let address = read(&mut out, "Game address (base58): ")?;
        anyhow::ensure!(!address.is_empty(), "No game address provided");
        return Ok(address);
    }
    writeln!(out, "Pending games:")?;
    for (index, row) in pending.iter().enumerate() {
        writeln!(out, "{:>2}. {} (attempts={})", index + 1, row.game_address, row.completion_attempts)?;
    }
    let response = read(&mut out, "Select # or paste address: ")?;
    if let Some(picked) = response.parse::<usize>().ok().filter(|n| *n >= 1).and_then(|n| pending.get(n - 1)) {
        return Ok(picked.game_address.clone());
    }
    anyhow::ensure!(!response.is_empty(), "No game address provided");
    Ok(response)
}

#[derive(Clone)]
struct LastJoin {
    player_address: String,
    ticket_index: i64,
    joined_slot: u64,
    game_last_slot_at_join: Option<u64>,
    observed_at_ms: i64,
}

#[derive(Default)]
struct AuditState {
    players_cache: Vec<Option<String>>,
    last_known_game: Option<GameAccount>,
    last_join: Option<LastJoin>,
    completion_status: Option<&'static str>,
    completion_observed_at_ms: Option<i64>,
    completion_slot: Option<u64>,
}

pub async fn run(argv: &[String]) -> anyhow::Result<()> {
    let options = parse_args(argv)?;
    let config = crate::config::OracleConfig::global().map_err(anyhow::Error::msg)?.clone();
    let oracle = OracleService::create(config)?;
    let result = audit(&oracle, options, &mut std::io::BufReader::new(std::io::stdin()), &mut std::io::stdout()).await;
    oracle.close().await;
    result
}

async fn audit(oracle: &Arc<OracleService>, options: CliOptions, input: Input<'_>, out: Out<'_>) -> anyhow::Result<()> {
    let db = oracle.db().clone();
    let completion = oracle.completion_manager().clone();
    let interactive = options.game_address.is_none();
    let mut game_address = options.game_address.clone().unwrap_or_default().trim().to_string();
    loop {
        if game_address.is_empty() {
            game_address = prompt_select_game(&db, &mut *input, &mut *out)?;
        }
        if db.get_secret_key_info(&game_address).is_some() {
            break;
        }
        let tracked = match db.get_game_status(&game_address) {
            Some(status) => format!("tracked(status={status})"),
            None => "not tracked".into(),
        };
        let hint = [
            format!("No secret key found in this oracle DB for {game_address} ({tracked})."),
            "This tool can only audit games that were created by this oracle instance (/generate-hash), because it needs the secret key.".into(),
            "Pick one of the listed pending games, or paste an address that appears in this oracle.sqlite.".into(),
        ]
        .join("\n");
        if !interactive {
            anyhow::bail!(hint);
        }
        eprintln!("{hint}");
        game_address.clear();
    }

    let secret = db
        .get_secret_key_info(&game_address)
        .ok_or_else(|| anyhow::anyhow!("No secret key found in local DB for {game_address}"))?;
    let secret_key = hex::decode(&secret.secret_key)?;
    let game_pda = Address::parse(&game_address).map_err(|e| anyhow::anyhow!("{e}"))?;
    let state = Arc::new(Mutex::new(AuditState {
        players_cache: db.get_game_players(&game_address).into_iter().map(Some).collect(),
        completion_status: secret.used.then_some("completed"),
        ..Default::default()
    }));

    let program = oracle.program().clone();
    let mut listener_ids = Vec::new();
    if options.listen {
        for event in
            [EventName::PlayerJoined, EventName::PlayerUnjoined, EventName::GameCompleted, EventName::GameClosed]
        {
            let state = state.clone();
            let game = game_address.clone();
            let db = db.clone();
            let write_db = options.write_db;
            let callback: EventCallback = Arc::new(move |dispatch| {
                let mut state = state.lock().unwrap();
                match dispatch {
                    ProgramDispatch::PlayerMembership(event) if event.game_key == game => {
                        let mutation = match event.kind {
                            MembershipKind::Joined => {
                                state.last_join = Some(LastJoin {
                                    player_address: event.player.clone(),
                                    ticket_index: i64::from(event.ticket_index),
                                    joined_slot: event.slot,
                                    game_last_slot_at_join: state.last_known_game.as_ref().map(|g| g.last_slot),
                                    observed_at_ms: timba_common::time::now_ms(),
                                });
                                PlayerMutation::Joined {
                                    player_address: event.player,
                                    ticket_index: i64::from(event.ticket_index),
                                }
                            }
                            MembershipKind::Unjoined => PlayerMutation::Unjoined {
                                ticket_index: i64::from(event.ticket_index),
                                moved_participant: event.moved_participant,
                            },
                        };
                        apply_mutation_to_players_cache(&mut state.players_cache, &mutation);
                        if write_db {
                            if let Err(err) = db.apply_player_mutations(&game, &[mutation]) {
                                eprintln!("Failed to write player mutation: {err:#}");
                            }
                        }
                    }
                    ProgramDispatch::GameCompleted(event) if event.game_key == game => {
                        state.completion_status = Some("completed");
                        state.completion_observed_at_ms = Some(timba_common::time::now_ms());
                        state.completion_slot = Some(event.slot);
                    }
                    ProgramDispatch::GameClosed(event) if event.game_key == game => {
                        state.completion_status = Some("closed");
                        state.completion_observed_at_ms = Some(timba_common::time::now_ms());
                        state.completion_slot = Some(event.slot);
                    }
                    _ => {}
                }
                futures::future::ready(()).boxed()
            });
            listener_ids.push(program.add_event_listener(event, callback).await?);
        }
    }

    let poll = || async {
        let mut errors = Vec::new();
        let mut saw_rate_limit = false;
        let mut current_slot = None;
        let mut block_time = None;
        match oracle.connection().get_slot().await {
            Ok(slot) => {
                current_slot = Some(slot);
                if options.with_block_time {
                    match oracle.connection().get_block_time(slot).await {
                        Ok(time) => block_time = time,
                        Err(err) => errors.push(format!("RPC slot/time: {err}")),
                    }
                }
            }
            Err(err) => errors.push(format!("RPC slot/time: {err}")),
        }
        let game = match program.fetch_game(&game_pda).await {
            Ok(game) => Some(game),
            Err(err) if is_account_missing_error(&err.to_string()) => None,
            Err(err) => {
                errors.push(format!("Fetch game account: {err:#}"));
                None
            }
        };
        if errors.iter().any(|e| e.contains("429")) {
            saw_rate_limit = true;
        }

        let mut state = state.lock().unwrap();
        if game.is_none() && !errors.iter().any(|e| e.starts_with("Fetch game account")) {
            state.completion_status.get_or_insert("missing");
            state.completion_observed_at_ms.get_or_insert(timba_common::time::now_ms());
        }
        if let Some(game) = &game {
            state.last_known_game = Some(game.clone());
        }
        let players = if options.refresh_from_db_each_tick {
            let players = db.get_game_players(&game_address);
            state.players_cache = players.iter().cloned().map(Some).collect();
            players
        } else {
            materialize_players_cache(&state.players_cache)
        };
        if let Some(game) = &game {
            if !players.is_empty() && game.tickets_count as usize != players.len() {
                errors.push(format!(
                    "Player registry mismatch: on-chain ticketsCount={}, DB players={}",
                    game.tickets_count,
                    players.len()
                ));
            }
        }
        let entropy_slot = game.as_ref().or(state.last_known_game.as_ref()).map(|g| g.last_slot);
        let mut winner_now = None;
        if let (Some(slot), false) = (entropy_slot, players.is_empty()) {
            match completion.calculate_winner_index(&secret_key, slot, players.len() as u64) {
                Ok(index) => winner_now = Some(index),
                Err(err) => errors.push(format!("Compute winner: {err:#}")),
            }
        }
        let screen = render(&RenderInput {
            game_address: &game_address,
            state: &state,
            current_slot,
            block_time,
            game: game.as_ref(),
            players: &players,
            winner_now,
            errors: &errors,
            lookahead_slots: options.lookahead_slots,
            winner_for: &|slot, n| completion.calculate_winner_index(&secret_key, slot, n).unwrap_or(0),
        });
        (screen, saw_rate_limit, state.completion_status.is_some())
    };
    let mut show = |screen: String| -> anyhow::Result<()> {
        writeln!(out, "\x1Bc{screen}")?;
        Ok(out.flush()?)
    };

    let result: anyhow::Result<()> = async {
        let (screen, _, finished) = poll().await;
        show(screen)?;
        if options.once || finished {
            return Ok(());
        }
        let mut delay = options.interval_ms;
        loop {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let (screen, rate_limited, finished) = poll().await;
            show(screen)?;
            delay = if rate_limited { (delay * 2).clamp(2_000, 30_000) } else { options.interval_ms };
            if finished {
                return Ok(());
            }
        }
    }
    .await;
    for id in listener_ids {
        program.remove_event_listener(id).await;
    }
    result
}

struct RenderInput<'a> {
    game_address: &'a str,
    state: &'a AuditState,
    current_slot: Option<u64>,
    block_time: Option<i64>,
    game: Option<&'a GameAccount>,
    players: &'a [String],
    winner_now: Option<u32>,
    errors: &'a [String],
    lookahead_slots: u64,
    winner_for: &'a dyn Fn(u64, u64) -> u32,
}

fn render(input: &RenderInput<'_>) -> String {
    let state = input.state;
    let account = input.game.or(state.last_known_game.as_ref());
    let tickets_count = account.map(|g| g.tickets_count).unwrap_or(0);
    let last_slot = account.map(|g| g.last_slot).unwrap_or(0);
    let created_at = account.map(|g| g.created_at as i64);
    let expires_at = account.map(|g| (g.created_at + g.timeout) as i64);
    let is_final = state.completion_status.is_some();
    let status_line = match state.completion_status {
        Some("missing") => "completed (account missing)",
        Some(status) => status,
        None => "active",
    };
    let last_join = state
        .last_join
        .as_ref()
        .map(|j| {
            format!(
                "{} (ticketIndex={}, joinedSlot={}, gameLastSlotAtJoin={}, at={})",
                j.player_address,
                j.ticket_index,
                j.joined_slot,
                j.game_last_slot_at_join.map(|s| s.to_string()).unwrap_or_else(|| "n/a".into()),
                timba_common::time::iso_from_ms(j.observed_at_ms)
            )
        })
        .unwrap_or_else(|| "n/a".into());
    let winner_text = input
        .winner_now
        .map(|index| compute_winner_display(tickets_count, input.players, index))
        .unwrap_or_else(|| "n/a".into());

    let mut lines = vec![
        format!("Game: {}", input.game_address),
        format!(
            "Status: {status_line}{}{}",
            state
                .completion_observed_at_ms
                .map(|ms| format!(" | CompletedAt: {}", timba_common::time::iso_from_ms(ms)))
                .unwrap_or_default(),
            state.completion_slot.map(|s| format!(" | CompletedSlot: {s}")).unwrap_or_default()
        ),
        format!("Last joiner: {last_join}"),
        format!(
            "Slot: {} | BlockTime: {}",
            input.current_slot.map(|s| s.to_string()).unwrap_or_else(|| "n/a".into()),
            format_unix_seconds(input.block_time)
        ),
        format!("Tickets: {tickets_count} | Players(DB): {} | lastSlot(entropy): {last_slot}", input.players.len()),
        format!("CreatedAt: {} | ExpiresAt: {}", format_unix_seconds(created_at), format_unix_seconds(expires_at)),
        format!("Winner if completes now: {winner_text}"),
    ];
    if !is_final {
        let n = input.players.len() + 1;
        lines.push(String::new());
        lines.push(format!("If 1 new ticket joins at future slot (n={n}):"));
        match input.current_slot {
            Some(current) => {
                let mut wins: HashMap<usize, u64> = (0..n).map(|i| (i, 0)).collect();
                for offset in 1..=input.lookahead_slots {
                    let slot = current + offset;
                    let index = (input.winner_for)(slot, n as u64) as usize;
                    *wins.entry(index).or_default() += 1;
                    let label = if index == input.players.len() {
                        "<new join>"
                    } else {
                        input.players.get(index).map(String::as_str).unwrap_or("<missing>")
                    };
                    lines.push(format!("{slot:>12} -> index={index:>4} pos={:>4} winner={label}", index + 1));
                }
                lines.push(String::new());
                lines.push(format!("Win probability (next {} slots):", input.lookahead_slots));
                for p in calculate_win_probabilities(&wins, input.lookahead_slots, input.players) {
                    lines.push(format!(
                        "  pos={:>2} | {:>5}% ({:>3}/{}) | {}",
                        p.position,
                        format!("{:.1}", p.probability),
                        p.wins,
                        p.total,
                        format_player_label(&p.player_label, 12)
                    ));
                }
            }
            None => lines.push("n/a (slot unavailable)".into()),
        }
    }
    if !input.errors.is_empty() {
        lines.push(String::new());
        lines.push("Errors:".into());
        lines.extend(input.errors.iter().map(|e| format!("- {e}")));
    }
    lines.push(String::new());
    lines.push(if is_final { "Completed. Exiting..." } else { "Ctrl+C to exit." }.into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::config::OracleConfig;
    use crate::core::testing::{account_value, game_account, harness, harness_with, ws_node, Harness};
    use crate::indexed_events::{GameClosedEvent, GameCompletedEvent, PlayerMembershipEvent};
    use crate::solana::rpc::RpcError;
    use crate::solana::Keypair;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn options(game: Option<&str>) -> CliOptions {
        CliOptions {
            game_address: game.map(str::to_string),
            interval_ms: 100,
            lookahead_slots: 5,
            once: true,
            listen: false,
            refresh_from_db_each_tick: false,
            write_db: false,
            with_block_time: false,
        }
    }

    /// Runs the audit with `typed` as stdin and returns what it printed.
    async fn audit_output(h: &Harness, options: CliOptions, typed: &str) -> anyhow::Result<String> {
        let mut input = std::io::Cursor::new(typed.as_bytes().to_vec());
        let mut out = Vec::new();
        audit(&h.service, options, &mut input, &mut out).await?;
        Ok(String::from_utf8(out).unwrap())
    }

    fn join(h: &Harness, game: &str, players: &[String]) {
        let joins: Vec<_> = players
            .iter()
            .enumerate()
            .map(|(i, p)| PlayerMutation::Joined { player_address: p.clone(), ticket_index: i as i64 })
            .collect();
        h.service.db().apply_player_mutations(game, &joins).unwrap();
    }

    fn participants(game: &GameAccount) -> Vec<String> {
        game.participants.iter().map(Address::to_base58).collect()
    }

    #[tokio::test]
    async fn prompts_for_a_game_by_number_or_address() {
        let h = harness();
        let ask = |typed: &str| {
            let mut out = Vec::new();
            let picked = prompt_select_game(h.service.db(), &mut std::io::Cursor::new(typed.to_string()), &mut out);
            (picked.map_err(|e| e.to_string()), String::from_utf8(out).unwrap())
        };
        assert_eq!(ask(" typed \n"), (Ok("typed".into()), "Game address (base58): ".into()));
        assert_eq!(ask("\n").0, Err("No game address provided".into()));

        h.service.db().track_game("first", None, false).unwrap();
        let (picked, shown) = ask("1\n");
        assert_eq!(picked, Ok("first".into()));
        assert_eq!(shown, "Pending games:\n 1. first (attempts=0)\nSelect # or paste address: ");
        assert_eq!(ask("0\n").0, Ok("0".into()), "out-of-range numbers are addresses");
        assert_eq!(ask("pasted\n").0, Ok("pasted".into()));
        assert_eq!(ask("").0, Err("No game address provided".into()));
    }

    #[tokio::test]
    async fn only_games_with_a_local_secret_can_be_audited() {
        let h = harness();
        let err = audit_output(&h, options(Some("unknown")), "").await.unwrap_err().to_string();
        assert!(err.starts_with("No secret key found in this oracle DB for unknown (not tracked)."), "{err}");
        h.service.db().track_game("tracked", None, false).unwrap();
        let err = audit_output(&h, options(Some("tracked")), "").await.unwrap_err().to_string();
        assert!(err.contains("(tracked(status=pending))"), "{err}");

        // Interactively, it asks again until the game has a secret.
        let game = h.service.generate_game_secrets(None).unwrap().game_address;
        h.transport.on(|_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getAccountInfo" => Some(Ok(json!({ "value": null }))),
            _ => None,
        });
        let output = audit_output(&h, options(None), &format!("unknown\n{game}\n")).await.unwrap();
        assert!(output.contains(&format!("\x1BcGame: {game}\nStatus: completed (account missing) | CompletedAt: ")));
        assert!(output.contains("Completed. Exiting..."), "{output}");
    }

    #[tokio::test]
    async fn renders_the_live_view_with_lookahead_and_mismatches() {
        let h = harness();
        let game = h.service.generate_game_secrets(None).unwrap().game_address;
        let account = game_account(3, 10, 2, 1_700_000_000, 600);
        join(&h, &game, &participants(&account)[..2]);
        let value = account_value(&account);
        h.transport.on(move |_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getBlockTime" => Some(Ok(json!(1_700_000_050))),
            "getAccountInfo" => Some(Ok(value.clone())),
            _ => None,
        });
        let output = audit_output(&h, CliOptions { with_block_time: true, ..options(Some(&game)) }, "").await.unwrap();
        assert!(output.contains("Status: active\nLast joiner: n/a\n"), "{output}");
        assert!(output.contains("Slot: 100 | BlockTime: 2023-11-14T22:14:10.000Z\n"), "{output}");
        assert!(output.contains("Tickets: 3 | Players(DB): 2 | lastSlot(entropy): 99\n"), "{output}");
        assert!(output.contains("CreatedAt: 2023-11-14T22:13:20.000Z | ExpiresAt: 2023-11-14T22:23:20.000Z"));
        assert!(output.contains("Winner if completes now: "), "{output}");
        assert!(output.contains("If 1 new ticket joins at future slot (n=3):\n         101 -> index="), "{output}");
        assert!(output.contains("Win probability (next 5 slots):\n  pos= 1 |"), "{output}");
        assert!(output.contains("- Player registry mismatch: on-chain ticketsCount=3, DB players=2"), "{output}");
        assert!(output.ends_with("Ctrl+C to exit.\n"), "{output}");
    }

    #[tokio::test]
    async fn a_corrupt_secret_is_reported_instead_of_a_winner() {
        let h = harness();
        let account = game_account(2, 10, 2, 1_700_000_000, 600);
        let game = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
        h.service.db().save_secret_key(game, "abcd", &"00".repeat(32)).unwrap();
        join(&h, game, &participants(&account));
        let value = account_value(&account);
        h.transport.on(move |_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getAccountInfo" => Some(Ok(value.clone())),
            _ => None,
        });
        let output = audit_output(&h, options(Some(game)), "").await.unwrap();
        assert!(output.contains("- Compute winner: Secret key buffer must be at least"), "{output}");
        assert!(output.contains("Winner if completes now: n/a\n"), "{output}");
    }

    #[tokio::test(start_paused = true)]
    async fn backs_off_when_rate_limited_and_stops_once_the_game_is_gone() {
        let h = harness();
        let game = h.service.generate_game_secrets(None).unwrap().game_address;
        join(&h, &game, &["p".to_string()]);
        // The first poll (before any wait) is rate limited; the next one finds the game gone.
        let start = tokio::time::Instant::now();
        h.transport.on(move |_, method, _| {
            let first = start.elapsed() < Duration::from_millis(1_000);
            match (method, first) {
                ("getSlot", true) => Some(Err(RpcError::http(429, "Too Many Requests", None))),
                ("getSlot", false) => Some(Ok(json!(101))),
                ("getBlockTime", _) => Some(Err(RpcError::transport("RPC request failed: timeout"))),
                ("getAccountInfo", true) => Some(Err(RpcError::transport("RPC request failed: connection reset"))),
                ("getAccountInfo", false) => Some(Ok(json!({ "value": null }))),
                _ => None,
            }
        });
        let options =
            CliOptions { once: false, with_block_time: true, refresh_from_db_each_tick: true, ..options(Some(&game)) };
        let started = tokio::time::Instant::now();
        let output = audit_output(&h, options, "").await.unwrap();
        // The first poll's result never sets the delay; the second doubles it and clamps to 2s.
        assert_eq!(started.elapsed(), Duration::from_millis(100 + 2_000));
        let screens: Vec<&str> = output.split("\x1Bc").filter(|s| !s.is_empty()).collect();
        assert_eq!(screens.len(), 3, "{output}");
        assert!(screens[0].contains("- RPC slot/time: ") && screens[0].contains("429"), "{}", screens[0]);
        assert!(screens[0].contains("- Fetch game account: ") && screens[0].contains("Status: active"));
        assert!(screens[0].contains("n/a (slot unavailable)"), "{}", screens[0]);
        assert!(screens[2].contains("- RPC slot/time: ") && screens[2].contains("Status: completed (account missing)"));
        assert!(screens[2].contains("Tickets: 0 | Players(DB): 1"), "{}", screens[2]);
    }

    fn membership(kind: MembershipKind, game: &str, player: &str, ticket_index: u32) -> ProgramDispatch {
        ProgramDispatch::PlayerMembership(PlayerMembershipEvent {
            kind,
            game_key: game.into(),
            player: player.into(),
            tickets_count: 1,
            ticket_index,
            moved_participant: None,
            timestamp: 1,
            signature: "s".into(),
            slot: 120,
        })
    }

    #[tokio::test]
    async fn follows_membership_and_completion_events_while_listening() {
        let config = OracleConfig { solana_ws_endpoint: Some(ws_node().await), ..OracleConfig::for_tests() };
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let game = h.service.generate_game_secrets(None).unwrap().game_address;
        let value = account_value(&game_account(0, 10, 2, 1_700_000_000, 600));
        h.transport.on(move |_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getAccountInfo" => Some(Ok(value.clone())),
            _ => None,
        });

        let program = h.service.program().clone();
        let db = h.service.db().clone();
        let events = {
            let game = game.clone();
            async move {
                while program.listener_count() < 4 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                program.dispatch(membership(MembershipKind::Joined, &game, "alice", 0)).await;
                program.dispatch(membership(MembershipKind::Joined, "other-game", "bob", 0)).await;
                assert_eq!(db.get_game_players(&game), vec!["alice".to_string()], "written with --write-db");
                // A failed write is reported and the audit keeps going.
                db.close();
                program.dispatch(membership(MembershipKind::Unjoined, &game, "alice", 0)).await;
                program.dispatch(membership(MembershipKind::Joined, &game, "carol", 0)).await;
                let closed = GameClosedEvent {
                    game_key: game.clone(),
                    timestamp: 2,
                    operator: false,
                    signature: "c".into(),
                    slot: 130,
                };
                program.dispatch(ProgramDispatch::GameClosed(closed)).await;
                let completed = GameCompletedEvent {
                    game_key: game.clone(),
                    winner: "carol".into(),
                    tickets_count: 1,
                    winner_amount: 1,
                    fee_amount: 0,
                    timestamp: 3,
                    signature: "d".into(),
                    slot: 140,
                };
                program.dispatch(ProgramDispatch::GameCompleted(completed)).await;
            }
        };
        let options = CliOptions { once: false, listen: true, write_db: true, ..options(Some(&game)) };
        let (output, ()) = tokio::join!(audit_output(&h, options, ""), events);
        let output = output.unwrap();
        let last = output.rsplit("\x1Bc").next().unwrap();
        assert!(
            last.contains("Status: completed | CompletedAt: ") && last.contains(" | CompletedSlot: 140\n"),
            "{last}"
        );
        assert!(
            last.contains("Last joiner: carol (ticketIndex=0, joinedSlot=120, gameLastSlotAtJoin=99, at="),
            "{last}"
        );
        assert!(last.contains("Players(DB): 1"), "{last}");
        assert_eq!(h.service.program().listener_count(), 0, "listeners are removed on exit");
    }

    #[tokio::test]
    async fn events_are_not_written_to_the_database_by_default() {
        let config = OracleConfig { solana_ws_endpoint: Some(ws_node().await), ..OracleConfig::for_tests() };
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let game = h.service.generate_game_secrets(None).unwrap().game_address;
        let value = account_value(&game_account(0, 10, 2, 1_700_000_000, 600));
        h.transport.on(move |_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getAccountInfo" => Some(Ok(value.clone())),
            _ => None,
        });

        let program = h.service.program().clone();
        let db = h.service.db().clone();
        let events = {
            let game = game.clone();
            async move {
                while program.listener_count() < 4 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                program.dispatch(membership(MembershipKind::Joined, &game, "alice", 0)).await;
                assert!(db.get_game_players(&game).is_empty(), "read-only without --write-db");
                let completed = GameCompletedEvent {
                    game_key: game.clone(),
                    winner: "alice".into(),
                    tickets_count: 1,
                    winner_amount: 1,
                    fee_amount: 0,
                    timestamp: 3,
                    signature: "d".into(),
                    slot: 140,
                };
                program.dispatch(ProgramDispatch::GameCompleted(completed)).await;
            }
        };
        let options = CliOptions { once: false, listen: true, ..options(Some(&game)) };
        let (output, ()) = tokio::join!(audit_output(&h, options, ""), events);
        let output = output.unwrap();
        let last = output.rsplit("\x1Bc").next().unwrap();
        assert!(last.contains("Last joiner: alice (ticketIndex=0"), "{last}");
    }

    #[test]
    fn parses_flags() {
        let options = parse_args(&args(&["--once", "--slots", "10", "--interval", "500", "GAME"])).unwrap();
        assert_eq!(options.game_address.as_deref(), Some("GAME"));
        assert!(options.once && options.listen);
        assert_eq!((options.lookahead_slots, options.interval_ms), (10, 500));
        assert_eq!(
            parse_args(&args(&["--interval", "5"])).unwrap_err().to_string(),
            "--interval must be a number >= 100 (ms)"
        );
        assert_eq!(parse_args(&args(&["--slots"])).unwrap_err().to_string(), "Missing value for --slots");
        assert_eq!(parse_args(&args(&["--bogus"])).unwrap_err().to_string(), "Unknown argument: --bogus");
        assert_eq!(parse_args(&args(&["--game", "A", "B"])).unwrap().game_address.as_deref(), Some("A"));
        // Empty arguments (an unset shell variable, say) are ignored.
        assert_eq!(parse_args(&args(&["", "GAME", ""])).unwrap().game_address.as_deref(), Some("GAME"));
    }

    #[test]
    fn winner_display_covers_missing_players() {
        let players = vec!["alice".to_string(), "bob".to_string()];
        assert_eq!(compute_winner_display(2, &players, 1), "bob (index=1, position=2)");
        assert_eq!(compute_winner_display(3, &players, 2), "index=2 (missing player)");
        assert_eq!(compute_winner_display(0, &players, 0), "n/a (no players)");
        assert_eq!(compute_winner_display(2, &[], 0), "n/a (no players)");
    }

    #[test]
    fn players_cache_and_probabilities() {
        let mut cache = vec![];
        apply_mutation_to_players_cache(
            &mut cache,
            &PlayerMutation::Joined { player_address: "b".into(), ticket_index: 1 },
        );
        apply_mutation_to_players_cache(
            &mut cache,
            &PlayerMutation::Joined { player_address: "a".into(), ticket_index: 0 },
        );
        apply_mutation_to_players_cache(
            &mut cache,
            &PlayerMutation::Unjoined { ticket_index: 0, moved_participant: Some("b".into()) },
        );
        apply_mutation_to_players_cache(
            &mut cache,
            &PlayerMutation::Unjoined { ticket_index: 1, moved_participant: None },
        );
        assert_eq!(materialize_players_cache(&cache), vec!["b".to_string()]);

        let wins = HashMap::from([(0, 3), (1, 1)]);
        let probabilities = calculate_win_probabilities(&wins, 4, &["p".to_string()]);
        assert_eq!(probabilities[0].probability, 75.0);
        assert_eq!(probabilities[1].player_label, "<new join>");
        assert_eq!(format_player_label("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", 12), "9xQe...VFin");
        assert_eq!(format_player_label("short", 12), "short");
    }
}
