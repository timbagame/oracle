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
use super::schema::{
    address_param, array, coerce_int, enum_param, js_number, js_string, normalize_number, parse, InvalidQuery,
    QueryParams, Schema,
};
use super::types::Row;

// ---------------------------------------------------------------------------
// Response schemas (`@timbagame/protocol/indexer`)
// ---------------------------------------------------------------------------

const GAME_TYPES: &[&str] = &["coinflip", "giveaway"];
const GAME_STATUSES: &[&str] = &["active", "completed", "cancelled"];

static NULLABLE_AMOUNT: Schema = Schema::Nullable(&Schema::NonNegativeNumber);
static NULLABLE_ADDRESS: Schema = Schema::Nullable(&Schema::Address);
static NULLABLE_GAME_TYPE: Schema = Schema::Nullable(&Schema::Enum(GAME_TYPES));
static NULLABLE_INTEGER: Schema = Schema::Nullable(&Schema::NonNegativeInteger);
static NULLABLE_BOOL: Schema = Schema::Nullable(&Schema::Bool);
static NULLABLE_PRICE: Schema = Schema::Nullable(&Schema::NonNegativeNumber);

pub static INDEXER_GAME: Schema = Schema::Object(&[
    ("signature", Schema::Signature),
    ("gameKey", Schema::Address),
    ("status", Schema::Optional(&Schema::Enum(GAME_STATUSES))),
    ("creator", Schema::Optional(&NULLABLE_ADDRESS)),
    ("gameType", Schema::Optional(&NULLABLE_GAME_TYPE)),
    ("ticketAmount", Schema::Optional(&NULLABLE_AMOUNT)),
    ("totalAmount", Schema::Optional(&NULLABLE_AMOUNT)),
    ("maxTickets", Schema::Optional(&NULLABLE_INTEGER)),
    ("minTickets", Schema::Optional(&NULLABLE_INTEGER)),
    ("isPrivate", Schema::Optional(&NULLABLE_BOOL)),
    ("createdAt", Schema::Optional(&NULLABLE_INTEGER)),
    ("timeout", Schema::Optional(&NULLABLE_INTEGER)),
    ("expiresAt", Schema::Optional(&NULLABLE_INTEGER)),
    ("winner", Schema::Nullable(&Schema::Address)),
    ("winnerAmount", Schema::Nullable(&Schema::NonNegativeNumber)),
    ("feeAmount", Schema::Nullable(&Schema::NonNegativeNumber)),
    ("ticketsCount", Schema::Nullable(&Schema::NonNegativeInteger)),
    ("tokenMint", Schema::Address),
    ("timestamp", Schema::NonNegativeInteger),
    ("slot", Schema::NonNegativeInteger),
    ("priceUsd", Schema::Optional(&NULLABLE_PRICE)),
    ("isCreator", Schema::Optional(&Schema::Bool)),
    ("isPlayer", Schema::Optional(&Schema::Bool)),
    ("isJoined", Schema::Optional(&Schema::Bool)),
]);

static BIGGEST_WIN: Schema = Schema::Object(&[
    ("amount", Schema::NonNegativeNumber),
    ("winner", Schema::Address),
    ("signature", Schema::Signature),
]);

static TOKEN_FINANCIALS: Schema = Schema::Object(&[
    ("tokenMint", Schema::Address),
    ("totalVolume", Schema::NonNegativeNumber),
    ("totalFees", Schema::NonNegativeNumber),
    ("priceUsd", Schema::Optional(&NULLABLE_PRICE)),
    ("biggestWin", Schema::Nullable(&BIGGEST_WIN)),
]);

pub static STATS_RESPONSE: Schema = Schema::Object(&[
    ("totalGames", Schema::NonNegativeInteger),
    ("uniquePlayers", Schema::NonNegativeInteger),
    ("financials", array(&TOKEN_FINANCIALS)),
    ("lastUpdated", Schema::NonNegativeInteger),
]);

pub static GAMES_RESPONSE: Schema = Schema::Object(&[
    ("games", array(&INDEXER_GAME)),
    ("total", Schema::NonNegativeInteger),
    ("page", Schema::PositiveInteger),
    ("limit", Schema::PositiveInteger),
]);

pub static LATEST_GAMES_RESPONSE: Schema = array(&INDEXER_GAME);

pub static PLAYER_GAMES_RESPONSE: Schema = Schema::Object(&[
    ("games", array(&INDEXER_GAME)),
    ("count", Schema::NonNegativeInteger),
    ("limit", Schema::PositiveInteger),
    ("offset", Schema::NonNegativeInteger),
]);

static ACTIVE_GAME: Schema = Schema::Object(&[
    ("game_key", Schema::Address),
    ("creator", Schema::Address),
    ("ticket_amount", Schema::NonNegativeNumber),
    ("total_amount", Schema::NonNegativeNumber),
    ("max_tickets", Schema::NonNegativeInteger),
    ("min_tickets", Schema::NonNegativeInteger),
    ("current_tickets", Schema::NonNegativeInteger),
    ("token_mint", Schema::Address),
    ("is_private", Schema::IntLiterals(&[0, 1])),
    ("created_at", Schema::NonNegativeInteger),
    ("timeout", Schema::NonNegativeInteger),
    ("signature", Schema::Signature),
    ("slot", Schema::NonNegativeInteger),
    ("indexed_at", Schema::NonNegativeInteger),
    ("expiresAt", Schema::NonNegativeInteger),
    ("timeLeft", Schema::NonNegativeInteger),
    ("isPrivate", Schema::Bool),
    ("game_type", Schema::Nullable(&Schema::Enum(GAME_TYPES))),
    ("priceUsd", Schema::Optional(&NULLABLE_PRICE)),
]);

pub static ACTIVE_GAMES_RESPONSE: Schema =
    Schema::Object(&[("games", array(&ACTIVE_GAME)), ("count", Schema::NonNegativeInteger)]);

const PROFILE_SUMMARY: Schema = Schema::Object(&[
    ("relatedGames", Schema::NonNegativeInteger),
    ("createdGames", Schema::NonNegativeInteger),
    ("playedGames", Schema::NonNegativeInteger),
    ("activeGames", Schema::NonNegativeInteger),
    ("completedGames", Schema::NonNegativeInteger),
    ("cancelledGames", Schema::NonNegativeInteger),
    ("wins", Schema::NonNegativeInteger),
    ("losses", Schema::NonNegativeInteger),
    ("lastActivity", Schema::Nullable(&Schema::NonNegativeInteger)),
]);

static PROFILE_TOKEN: Schema = Schema::Object(&[
    ("tokenMint", Schema::Address),
    ("gamesPlayed", Schema::NonNegativeInteger),
    ("stakedAmount", Schema::NonNegativeNumber),
    ("wonAmount", Schema::NonNegativeNumber),
    ("priceUsd", Schema::Optional(&NULLABLE_PRICE)),
]);

static FREQUENT_PLAYER: Schema =
    Schema::Object(&[("player", Schema::Address), ("gamesTogether", Schema::NonNegativeInteger)]);

pub static PLAYER_PROFILE: Schema = Schema::Object(&[
    ("wallet", Schema::Address),
    ("summary", PROFILE_SUMMARY),
    ("tokens", array(&PROFILE_TOKEN)),
    ("frequentPlayers", array(&FREQUENT_PLAYER)),
    ("historyComplete", Schema::Bool),
]);

static TOKEN_SUMMARY: Schema = Schema::Object(&[
    ("tokenMint", Schema::Address),
    ("games", Schema::NonNegativeInteger),
    ("latestTimestamp", Schema::NonNegativeInteger),
    ("priceUsd", Schema::Optional(&NULLABLE_PRICE)),
]);

pub static TOKENS_RESPONSE: Schema = Schema::Object(&[("tokens", array(&TOKEN_SUMMARY))]);

static LEADERBOARD_PLAYER: Schema = Schema::Object(&[
    ("player", Schema::Address),
    ("games_won", Schema::NonNegativeInteger),
    ("total_winnings", Schema::Nullable(&Schema::NonNegativeNumber)),
    ("avg_win", Schema::Nullable(&Schema::NonNegativeNumber)),
]);

pub static LEADERBOARD_RESPONSE: Schema =
    Schema::Object(&[("players", array(&LEADERBOARD_PLAYER)), ("count", Schema::NonNegativeInteger)]);

pub static HEALTH_RESPONSE: Schema =
    Schema::Object(&[("status", Schema::Literal("ok")), ("timestamp", Schema::NonNegativeInteger)]);

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

impl From<InvalidQuery> for Outcome {
    fn from(_: InvalidQuery) -> Self {
        Outcome::Error("Invalid query parameters", StatusCode::BAD_REQUEST)
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
                Ok(parsed) => response(StatusCode::OK, parsed.to_string(), cache),
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
            ($e:expr) => {
                match $e {
                    Ok(value) => value,
                    Err(invalid) => return Ok(Outcome::from(invalid)),
                }
            };
        }
        let token_mint = || address_param(query.last("tokenMint"), false);
        match path {
            "/health" => ok(&HEALTH_RESPONSE, json!({ "status": "ok", "timestamp": (self.now)() }), None),
            "/api/stats" => {
                let token_mint = query!(token_mint());
                let stats = self.db.get_stats(token_mint.as_deref())?;
                let mut value = serde_json::to_value(&stats)?;
                let financials: Vec<Row> = value["financials"]
                    .as_array()
                    .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
                    .unwrap_or_default();
                let priced = self.add_prices(financials, "tokenMint").await;
                value["financials"] = Value::Array(priced.into_iter().map(Value::Object).collect());
                ok(&STATS_RESPONSE, value, Some("public, max-age=10"))
            }
            "/api/games" => {
                let limit = query!(coerce_int(query.last("limit"), 50, 1, Some(100)));
                let offset = query!(coerce_int(query.last("offset"), 0, 0, None));
                let token_mint = query!(token_mint());
                let result = self.db.get_games(limit, offset, token_mint.as_deref())?;
                let games = result.games.iter().map(serialize_completed).collect();
                let games = self.add_prices(games, "tokenMint").await;
                ok(
                    &GAMES_RESPONSE,
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
                let limit = query!(coerce_int(query.last("limit"), 10, 1, Some(100)));
                let token_mint = query!(token_mint());
                let game_type = query!(enum_param(query.last("gameType"), GAME_TYPES, None));
                let include_lifecycle = query!(enum_param(query.last("includeLifecycle"), &["0", "1"], None));
                let games: Vec<Row> = if include_lifecycle.as_deref() == Some("1") {
                    self.db
                        .get_lifecycle(limit, token_mint.as_deref(), game_type.as_deref())?
                        .iter()
                        .map(serialize_lifecycle)
                        .collect()
                } else {
                    self.db
                        .get_games(limit, 0, token_mint.as_deref())?
                        .games
                        .iter()
                        .map(serialize_compact_latest)
                        .collect()
                };
                let priced = self.add_prices(games, "tokenMint").await;
                ok(&LATEST_GAMES_RESPONSE, json!(priced), Some("public, max-age=5"))
            }
            "/api/games/by-key" => {
                let game_key = query!(address_param(query.last("gameKey"), true)).unwrap_or_default();
                let Some(game) = self.db.get_game(&game_key)? else {
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
                let limit = query!(coerce_int(query.last("limit"), 20, 1, Some(100)));
                let token_mint = query!(token_mint());
                let period = query!(enum_param(query.last("period"), &["24h", "7d", "all"], Some("all")));
                let period = period.as_deref().and_then(LeaderboardPeriod::parse).unwrap_or_default();
                let players = self.db.get_leaderboard(limit, token_mint.as_deref(), period)?;
                ok(
                    &LEADERBOARD_RESPONSE,
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
                ok(&TOKENS_RESPONSE, json!({ "tokens": tokens }), Some("public, max-age=30"))
            }
            "/api/active-games" | "/api/my-active-games" => {
                let player = if path == "/api/my-active-games" {
                    query!(address_param(query.last("player"), true))
                } else {
                    None
                };
                let now = (self.now)().div_euclid(1000);
                let games: Vec<Row> = self
                    .db
                    .get_active_games(player.as_deref())?
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
                    &ACTIVE_GAMES_RESPONSE,
                    json!({ "count": priced.len(), "games": priced }),
                    Some("public, max-age=5, stale-while-revalidate=10"),
                )
            }
            "/api/player-games" => {
                let limit = query!(coerce_int(query.last("limit"), 50, 1, Some(100)));
                let offset = query!(coerce_int(query.last("offset"), 0, 0, None));
                let player = query!(address_param(query.last("player"), true)).unwrap_or_default();
                let games: Vec<Row> = self
                    .db
                    .get_player_games(&player, limit, offset)?
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
                    &PLAYER_GAMES_RESPONSE,
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
                let player = query!(address_param(query.last("player"), true)).unwrap_or_default();
                let profile = self.db.get_player_profile(&player)?;
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
                ok(&PLAYER_PROFILE, value, Some("public, max-age=30, stale-while-revalidate=60"))
            }
            _ => Ok(Outcome::Error("Endpoint not found", StatusCode::NOT_FOUND)),
        }
    }
}
