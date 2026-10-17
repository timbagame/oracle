//! Public indexer HTTP API (port of `indexer/api.ts`), mounted at `/indexer`.
//! Authentication and rate limiting are applied by the outer router.

use std::sync::Arc;

use anyhow::Result;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use timba_common::error;

use super::database::{Clock, IndexerDatabase, LeaderboardPeriod};
use super::pricing::TokenUsdPrices;
use super::schema::{js_number, js_string, normalize_number, parse, to_js_json, QueryParams, Schema};
use super::types::Row;

use timba_protocol::http::indexer::{
    GAMES_QUERY, GAME_BY_KEY_QUERY, INDEXER_ACTIVE_GAMES_RESPONSE, INDEXER_GAME, INDEXER_GAMES_RESPONSE,
    INDEXER_HEALTH_RESPONSE, INDEXER_LEADERBOARD_RESPONSE, INDEXER_PLAYER_GAMES_RESPONSE, INDEXER_PLAYER_PROFILE,
    INDEXER_STATS_RESPONSE, INDEXER_TOKENS_RESPONSE, LATEST_GAMES_QUERY, LATEST_GAMES_RESPONSE, LEADERBOARD_QUERY,
    PLAYER_ADDRESS_QUERY, PLAYER_QUERY, STATS_QUERY,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

struct IndexerApi {
    db: Arc<IndexerDatabase>,
    jupiter_api_key: Option<String>,
    prices: Arc<TokenUsdPrices>,
    now: Clock,
}

/// Router for `/indexer` and `/indexer/*`.
pub fn router(db: Arc<IndexerDatabase>, jupiter_api_key: Option<String>) -> Router {
    router_with_prices(db, jupiter_api_key, TokenUsdPrices::global())
}

/// [`router`] with an explicit price source (tests inject a fake fetcher).
pub fn router_with_prices(
    db: Arc<IndexerDatabase>,
    jupiter_api_key: Option<String>,
    prices: Arc<TokenUsdPrices>,
) -> Router {
    router_with_clock(db, jupiter_api_key, prices, Arc::new(timba_common::time::now_ms))
}

pub(crate) fn router_with_clock(
    db: Arc<IndexerDatabase>,
    jupiter_api_key: Option<String>,
    prices: Arc<TokenUsdPrices>,
    now: Clock,
) -> Router {
    let api = Arc::new(IndexerApi { db, jupiter_api_key, prices, now });
    let handler = move |request: Request| {
        let api = api.clone();
        async move { api.handle(request).await }
    };
    Router::new()
        .route("/indexer", any(handler.clone()))
        .route("/indexer/", any(handler.clone()))
        .route("/indexer/{*rest}", any(handler))
}

fn response(status: StatusCode, body: String, cache: Option<&str>) -> Response {
    let mut builder = Response::builder().status(status).header(header::CONTENT_TYPE, "application/json");
    if let Some(cache) = cache {
        builder = builder.header(header::CACHE_CONTROL, cache);
    }
    builder.body(Body::from(body)).expect("valid response")
}

fn error_response(message: &str, status: StatusCode) -> Response {
    response(status, json!({ "error": message }).to_string(), None)
}

enum Outcome {
    Json { schema: &'static Schema, value: Value, cache: Option<&'static str> },
    Error(&'static str, StatusCode),
}

const INVALID_QUERY: Outcome = Outcome::Error("Invalid query parameters", StatusCode::BAD_REQUEST);

/// The query string parsed by its `indexerContract` schema.
struct Query(Value);

impl Query {
    fn parse(schema: &'static Schema, params: &QueryParams) -> Option<Self> {
        parse(schema, &params.to_object()).ok().map(Self)
    }

    /// A coerced integer field (every one has a default or is required).
    fn int(&self, key: &str) -> i64 {
        self.0[key].as_i64().expect("the query schema coerces integers")
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.0[key].as_str()
    }
}

fn ok(schema: &'static Schema, value: Value, cache: Option<&'static str>) -> Result<Outcome> {
    Ok(Outcome::Json { schema, value, cache })
}

fn field(row: &Row, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// JavaScript `a + b` for SQLite integers/reals.
fn add(a: &Value, b: &Value) -> Value {
    match (a.as_i64(), b.as_i64()) {
        (Some(x), Some(y)) => {
            x.checked_add(y).map(Value::from).unwrap_or_else(|| normalize_number(x as f64 + y as f64))
        }
        _ => normalize_number(a.as_f64().unwrap_or(f64::NAN) + b.as_f64().unwrap_or(f64::NAN)),
    }
}

fn serialize_lifecycle(game: &Row) -> Row {
    let created_at = field(game, "created_at");
    let timeout = field(game, "timeout");
    let is_private = field(game, "is_private");
    let mut out = Row::new();
    out.insert("signature".into(), field(game, "signature"));
    out.insert("gameKey".into(), field(game, "game_key"));
    out.insert("status".into(), field(game, "status"));
    out.insert("creator".into(), field(game, "creator"));
    out.insert("gameType".into(), field(game, "game_type"));
    out.insert("ticketAmount".into(), field(game, "ticket_amount"));
    out.insert("totalAmount".into(), field(game, "total_amount"));
    out.insert("maxTickets".into(), field(game, "max_tickets"));
    out.insert("minTickets".into(), field(game, "min_tickets"));
    out.insert(
        "isPrivate".into(),
        if is_private.is_null() { Value::Null } else { Value::Bool(is_private == json!(1)) },
    );
    out.insert("createdAt".into(), created_at.clone());
    out.insert("timeout".into(), timeout.clone());
    out.insert(
        "expiresAt".into(),
        if created_at.is_null() || timeout.is_null() { Value::Null } else { add(&created_at, &timeout) },
    );
    out.insert("winner".into(), field(game, "winner"));
    out.insert("winnerAmount".into(), field(game, "winner_amount"));
    out.insert("feeAmount".into(), field(game, "fee_amount"));
    out.insert("ticketsCount".into(), field(game, "tickets_count"));
    out.insert("tokenMint".into(), field(game, "token_mint"));
    out.insert("timestamp".into(), field(game, "timestamp"));
    out.insert("slot".into(), field(game, "slot"));
    out
}

/// The compact `/api/games` row.
fn serialize_completed(game: &Row) -> Row {
    let mut out = Row::new();
    out.insert("signature".into(), js_string(&field(game, "signature")));
    out.insert("gameKey".into(), js_string(&field(game, "game_key")));
    out.insert("winner".into(), js_string(&field(game, "winner")));
    out.insert("winnerAmount".into(), js_number(&field(game, "winner_amount")));
    out.insert("feeAmount".into(), js_number(&field(game, "fee_amount")));
    out.insert("ticketsCount".into(), js_number(&field(game, "tickets_count")));
    out.insert("tokenMint".into(), js_string(&field(game, "token_mint")));
    out.insert("timestamp".into(), js_number(&field(game, "timestamp")));
    out.insert("slot".into(), js_number(&field(game, "slot")));
    out
}

/// The latest-games row without lifecycle data.
fn serialize_compact_latest(game: &Row) -> Row {
    let mut out = Row::new();
    out.insert("signature".into(), js_string(&field(game, "signature")));
    out.insert("gameKey".into(), js_string(&field(game, "game_key")));
    out.insert("status".into(), json!("completed"));
    for key in [
        "creator",
        "gameType",
        "ticketAmount",
        "totalAmount",
        "maxTickets",
        "minTickets",
        "isPrivate",
        "createdAt",
        "timeout",
        "expiresAt",
    ] {
        out.insert(key.into(), Value::Null);
    }
    out.insert("winner".into(), js_string(&field(game, "winner")));
    out.insert("winnerAmount".into(), js_number(&field(game, "winner_amount")));
    out.insert("feeAmount".into(), js_number(&field(game, "fee_amount")));
    out.insert("ticketsCount".into(), js_number(&field(game, "tickets_count")));
    out.insert("tokenMint".into(), js_string(&field(game, "token_mint")));
    out.insert("timestamp".into(), js_number(&field(game, "timestamp")));
    out.insert("slot".into(), js_number(&field(game, "slot")));
    out
}

fn mint_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => js_string(other).as_str().unwrap_or_default().to_string(),
    }
}

fn number_row(source: &Row, fields: &[(&str, &str, bool)]) -> Row {
    let mut out = Row::new();
    for (to, from, numeric) in fields {
        let value = field(source, from);
        out.insert((*to).into(), if *numeric { js_number(&value) } else { js_string(&value) });
    }
    out
}

impl IndexerApi {
    async fn add_prices(&self, mut values: Vec<Row>, mint_field: &str) -> Vec<Row> {
        let mints: Vec<String> = values.iter().map(|value| mint_key(&field(value, mint_field))).collect();
        let prices = self.prices.get(&mints, self.jupiter_api_key.as_deref()).await;
        for (value, mint) in values.iter_mut().zip(mints) {
            let price = prices.get(&mint).map_or(Value::Null, |p| normalize_number(*p));
            value.insert("priceUsd".into(), price);
        }
        values
    }

    async fn handle(&self, request: Request) -> Response {
        if request.method() != Method::GET {
            return error_response("Method not allowed", StatusCode::METHOD_NOT_ALLOWED);
        }
        let pathname = request.uri().path();
        let path = match pathname.strip_prefix("/indexer").unwrap_or(pathname) {
            "" => "/".to_string(),
            rest => rest.to_string(),
        };
        let query = QueryParams::parse(request.uri().query());
        match self.route(&path, &query).await {
            Ok(Outcome::Error(message, status)) => error_response(message, status),
            Ok(Outcome::Json { schema, value, cache }) => match parse(schema, &value) {
                Ok(parsed) => response(StatusCode::OK, to_js_json(&parsed), cache),
                Err(e) => {
                    error!("Indexer API failed for {path}: {e}");
                    error_response("Internal server error", StatusCode::INTERNAL_SERVER_ERROR)
                }
            },
            Err(e) => {
                error!("Indexer API failed for {path}: {e:#}");
                error_response("Internal server error", StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    }

    async fn route(&self, path: &str, query: &QueryParams) -> Result<Outcome> {
        macro_rules! query {
            ($schema:expr) => {
                match Query::parse(&$schema, query) {
                    Some(parsed) => parsed,
                    None => return Ok(INVALID_QUERY),
                }
            };
        }
        match path {
            "/health" => ok(&INDEXER_HEALTH_RESPONSE, json!({ "status": "ok", "timestamp": (self.now)() }), None),
            "/api/stats" => {
                let query = query!(STATS_QUERY);
                let stats = self.db.get_stats(query.text("tokenMint"))?;
                let mut value = serde_json::to_value(&stats)?;
                let financials: Vec<Row> = value["financials"]
                    .as_array()
                    .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
                    .unwrap_or_default();
                let priced = self.add_prices(financials, "tokenMint").await;
                value["financials"] = Value::Array(priced.into_iter().map(Value::Object).collect());
                ok(&INDEXER_STATS_RESPONSE, value, Some("public, max-age=10"))
            }
            "/api/games" => {
                let query = query!(GAMES_QUERY);
                let (limit, offset) = (query.int("limit"), query.int("offset"));
                let result = self.db.get_games(limit, offset, query.text("tokenMint"))?;
                let games = result.games.iter().map(serialize_completed).collect();
                let games = self.add_prices(games, "tokenMint").await;
                ok(
                    &INDEXER_GAMES_RESPONSE,
                    json!({
                        "games": games,
                        "total": result.total,
                        "page": offset.div_euclid(limit) + 1,
                        "limit": limit,
                    }),
                    Some("public, max-age=5"),
                )
            }
            "/api/games/latest" => {
                let query = query!(LATEST_GAMES_QUERY);
                let (limit, token_mint) = (query.int("limit"), query.text("tokenMint"));
                let games: Vec<Row> = if query.text("includeLifecycle") == Some("1") {
                    self.db
                        .get_lifecycle(limit, token_mint, query.text("gameType"))?
                        .iter()
                        .map(serialize_lifecycle)
                        .collect()
                } else {
                    self.db.get_games(limit, 0, token_mint)?.games.iter().map(serialize_compact_latest).collect()
                };
                let priced = self.add_prices(games, "tokenMint").await;
                ok(&LATEST_GAMES_RESPONSE, json!(priced), Some("public, max-age=5"))
            }
            "/api/games/by-key" => {
                let query = query!(GAME_BY_KEY_QUERY);
                let Some(game) = self.db.get_game(query.text("gameKey").unwrap_or_default())? else {
                    return Ok(Outcome::Error("Game not found", StatusCode::NOT_FOUND));
                };
                let priced = self.add_prices(vec![serialize_lifecycle(&game)], "tokenMint").await;
                ok(
                    &INDEXER_GAME,
                    Value::Object(priced.into_iter().next().unwrap_or_default()),
                    Some("public, max-age=2, stale-while-revalidate=2"),
                )
            }
            "/api/leaderboard" => {
                let query = query!(LEADERBOARD_QUERY);
                // The schema only lets through periods `LeaderboardPeriod` knows.
                let period = query.text("period").and_then(LeaderboardPeriod::parse).unwrap_or_default();
                let players = self.db.get_leaderboard(query.int("limit"), query.text("tokenMint"), period)?;
                ok(
                    &INDEXER_LEADERBOARD_RESPONSE,
                    json!({ "count": players.len(), "players": players }),
                    Some("public, max-age=30"),
                )
            }
            "/api/tokens" => {
                let tokens: Vec<Row> = self
                    .db
                    .get_tokens()?
                    .iter()
                    .map(|token| {
                        number_row(
                            token,
                            &[
                                ("tokenMint", "tokenMint", false),
                                ("games", "games", true),
                                ("latestTimestamp", "latestTimestamp", true),
                            ],
                        )
                    })
                    .collect();
                let tokens = self.add_prices(tokens, "tokenMint").await;
                ok(&INDEXER_TOKENS_RESPONSE, json!({ "tokens": tokens }), Some("public, max-age=30"))
            }
            "/api/active-games" | "/api/my-active-games" => {
                let player = if path == "/api/my-active-games" { Some(query!(PLAYER_ADDRESS_QUERY)) } else { None };
                let player = player.as_ref().and_then(|query| query.text("player"));
                let now = (self.now)().div_euclid(1000);
                let games: Vec<Row> = self
                    .db
                    .get_active_games(player)?
                    .into_iter()
                    .filter_map(|mut game| {
                        let expires_at = add(&field(&game, "created_at"), &field(&game, "timeout"));
                        if !expires_at.as_f64().is_some_and(|e| e > now as f64) {
                            return None;
                        }
                        let time_left = add(&expires_at, &json!(-now));
                        let is_private = field(&game, "is_private") == json!(1);
                        game.insert("expiresAt".into(), expires_at);
                        game.insert("timeLeft".into(), time_left);
                        game.insert("isPrivate".into(), Value::Bool(is_private));
                        Some(game)
                    })
                    .collect();
                let priced = self.add_prices(games, "token_mint").await;
                ok(
                    &INDEXER_ACTIVE_GAMES_RESPONSE,
                    json!({ "count": priced.len(), "games": priced }),
                    Some("public, max-age=5, stale-while-revalidate=10"),
                )
            }
            "/api/player-games" => {
                let query = query!(PLAYER_QUERY);
                let (limit, offset) = (query.int("limit"), query.int("offset"));
                let games: Vec<Row> = self
                    .db
                    .get_player_games(query.text("player").unwrap_or_default(), limit, offset)?
                    .iter()
                    .map(|game| {
                        let mut out = serialize_lifecycle(game);
                        for (from, to) in
                            [("is_creator", "isCreator"), ("is_player", "isPlayer"), ("is_joined", "isJoined")]
                        {
                            out.insert(to.into(), Value::Bool(field(game, from) == json!(1)));
                        }
                        out
                    })
                    .collect();
                let priced = self.add_prices(games, "tokenMint").await;
                ok(
                    &INDEXER_PLAYER_GAMES_RESPONSE,
                    json!({
                        "games": priced,
                        "count": priced.len(),
                        "limit": limit,
                        "offset": offset,
                    }),
                    Some("public, max-age=5, stale-while-revalidate=10"),
                )
            }
            "/api/player-profile" => {
                let query = query!(PLAYER_ADDRESS_QUERY);
                let player = query.text("player").unwrap_or_default();
                let profile = self.db.get_player_profile(player)?;
                let tokens: Vec<Row> = profile
                    .tokens
                    .iter()
                    .map(|token| {
                        number_row(
                            token,
                            &[
                                ("tokenMint", "token_mint", false),
                                ("gamesPlayed", "games_played", true),
                                ("stakedAmount", "staked_amount", true),
                                ("wonAmount", "won_amount", true),
                            ],
                        )
                    })
                    .collect();
                let summary = |key: &str| js_number(&field(&profile.summary, key));
                let last_activity = field(&profile.summary, "last_activity");
                let frequent_players: Vec<Row> = profile
                    .frequent_players
                    .iter()
                    .map(|item| {
                        number_row(item, &[("player", "player", false), ("gamesTogether", "games_together", true)])
                    })
                    .collect();
                let value = json!({
                    "wallet": player,
                    "summary": {
                        "relatedGames": summary("related_games"),
                        "createdGames": summary("created_games"),
                        "playedGames": summary("played_games"),
                        "activeGames": summary("active_games"),
                        "completedGames": summary("completed_games"),
                        "cancelledGames": summary("cancelled_games"),
                        "wins": summary("wins"),
                        "losses": summary("losses"),
                        "lastActivity": if last_activity.is_null() {
                            Value::Null
                        } else {
                            js_number(&last_activity)
                        },
                    },
                    "tokens": self.add_prices(tokens, "tokenMint").await,
                    "frequentPlayers": frequent_players,
                    "historyComplete": profile.history_complete,
                });
                ok(&INDEXER_PLAYER_PROFILE, value, Some("public, max-age=30, stale-while-revalidate=60"))
            }
            _ => Ok(Outcome::Error("Endpoint not found", StatusCode::NOT_FOUND)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_like_javascript() {
        assert_eq!(add(&json!(1_000), &json!(3_600)), json!(4_600));
        // Past the 64-bit range the sum is a float, like in JavaScript.
        assert_eq!(add(&json!(i64::MAX), &json!(1)), json!(9_223_372_036_854_775_808u64 as f64));
        // Any non-integer operand makes it a float addition.
        assert_eq!(add(&json!(1.5), &json!(2)), json!(3.5));
        assert_eq!(add(&json!(2), &json!(0.25)), json!(2.25));
        assert_eq!(add(&json!(0.5), &json!(0.5)), json!(1));
        // Anything else is NaN, which JSON writes as null.
        assert_eq!(add(&json!("text"), &json!(1)), Value::Null);
    }

    #[test]
    fn keys_prices_by_the_mint_as_javascript_would_print_it() {
        assert_eq!(
            mint_key(&json!("So11111111111111111111111111111111111111112")),
            "So11111111111111111111111111111111111111112"
        );
        assert_eq!(mint_key(&json!(42)), "42");
        assert_eq!(mint_key(&Value::Null), "null");
        assert_eq!(mint_key(&json!([1, 2])), "[1,2]");
    }
}
