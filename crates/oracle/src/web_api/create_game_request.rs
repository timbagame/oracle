//! Public game creation request validation (port of
//! `web-api/create-game-request.ts` and the protocol `CreateGameRequestSchema`).

use serde_json::Value;
use timba_protocol::contracts::GameType;
use timba_protocol::validators::{is_solana_address, is_u64_string};
use timba_protocol::Address;

use crate::indexer::schema::MAX_SAFE_INTEGER;

/// An error whose message is safe to return to web clients (HTTP 400).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{public_message}")]
pub struct CreateGameValidationError {
    pub public_message: String,
}

impl CreateGameValidationError {
    pub fn new(public_message: impl Into<String>) -> Self {
        Self { public_message: public_message.into() }
    }
}

fn invalid<T>(message: &str) -> Result<T, CreateGameValidationError> {
    Err(CreateGameValidationError::new(message))
}

/// `CreateGameRequest` (every field optional, numbers as JavaScript numbers).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreateGameRequest {
    pub creator: Option<String>,
    pub token_mint: Option<String>,
    pub game_type: Option<String>,
    pub amount: Option<String>,
    pub min_players: Option<f64>,
    pub max_players: Option<f64>,
    pub timeout_seconds: Option<f64>,
}

/// The validated request (`validateCreateGameRequest` result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCreateGame {
    pub creator: Address,
    pub token_mint: Address,
    pub game_type: GameType,
    pub amount: u64,
    pub min_players: u32,
    pub max_players: u32,
    pub timeout_seconds: u64,
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// `validateCreateGameRequest`.
pub fn validate_create_game_request(
    body: &CreateGameRequest,
) -> Result<ValidatedCreateGame, CreateGameValidationError> {
    let parse_address = |value: &Option<String>| Address::parse(value.as_deref().unwrap_or(""));
    let (Ok(creator), Ok(token_mint)) = (parse_address(&body.creator), parse_address(&body.token_mint)) else {
        return invalid("Invalid creator or token address");
    };
    let Some(game_type) = body.game_type.as_deref().and_then(GameType::from_name) else {
        return invalid("Invalid game type");
    };
    let amount = match body.amount.as_deref() {
        Some(amount) if (1..=20).contains(&amount.len()) && amount.bytes().all(|b| b.is_ascii_digit()) => {
            amount.parse::<u128>().expect("at most 20 digits")
        }
        _ => return invalid("Invalid amount"),
    };
    if amount == 0 {
        return invalid("Amount must be positive");
    }
    let Ok(amount) = u64::try_from(amount) else {
        return invalid("Amount is too large");
    };

    let min_players = body.min_players.unwrap_or(0.0);
    let max_players = body.max_players.unwrap_or(0.0);
    let minimum_players = if game_type == GameType::Coinflip { 2.0 } else { 1.0 };
    if !is_integer(min_players) || !is_integer(max_players) {
        return invalid("Player limits must be whole numbers");
    }
    if min_players < minimum_players || max_players < min_players || max_players > 100.0 {
        return invalid("Player limits are invalid");
    }

    let timeout_seconds = body.timeout_seconds.unwrap_or(0.0);
    if !is_integer(timeout_seconds) || !(60.0..=86_400.0).contains(&timeout_seconds) {
        return invalid("Timeout must be between 1 minute and 24 hours");
    }

    Ok(ValidatedCreateGame {
        creator,
        token_mint,
        game_type,
        amount,
        min_players: min_players as u32,
        max_players: max_players as u32,
        timeout_seconds: timeout_seconds as u64,
    })
}

const FIELDS: [&str; 7] = ["creator", "tokenMint", "type", "amount", "minPlayers", "maxPlayers", "timeoutSeconds"];

fn safe_integer_in(value: &Value, min: f64, max: f64) -> Option<f64> {
    let number = value.as_f64()?;
    (is_integer(number) && number.abs() <= MAX_SAFE_INTEGER && number >= min && number <= max).then_some(number)
}

/// `CreateGameRequestSchema.safeParse`: a strict object with every field
/// required, plus the player-limit refinements.
pub fn parse_create_game_request(value: &Value) -> Option<CreateGameRequest> {
    let object = value.as_object()?;
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return None;
    }
    let address = |key: &str| object.get(key)?.as_str().filter(|s| is_solana_address(s)).map(String::from);
    let creator = address("creator")?;
    let token_mint = address("tokenMint")?;
    let game_type = object.get("type")?.as_str().filter(|t| matches!(*t, "coinflip" | "giveaway"))?;
    let amount = object.get("amount")?.as_str().filter(|a| is_u64_string(a) && *a != "0")?;
    let min_players = safe_integer_in(object.get("minPlayers")?, 1.0, 100.0)?;
    let max_players = safe_integer_in(object.get("maxPlayers")?, 1.0, 100.0)?;
    let timeout_seconds = safe_integer_in(object.get("timeoutSeconds")?, 60.0, 86_400.0)?;
    let minimum_players = if game_type == "coinflip" { 2.0 } else { 1.0 };
    if min_players < minimum_players || max_players < min_players {
        return None;
    }
    Some(CreateGameRequest {
        creator: Some(creator),
        token_mint: Some(token_mint),
        game_type: Some(game_type.to_string()),
        amount: Some(amount.to_string()),
        min_players: Some(min_players),
        max_players: Some(max_players),
        timeout_seconds: Some(timeout_seconds),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_api::token_utils::TIMBA_MINT;
    use serde_json::json;

    const CREATOR: &str = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

    fn valid() -> CreateGameRequest {
        CreateGameRequest {
            creator: Some(CREATOR.into()),
            token_mint: Some(TIMBA_MINT.into()),
            game_type: Some("coinflip".into()),
            amount: Some("1000000".into()),
            min_players: Some(2.0),
            max_players: Some(4.0),
            timeout_seconds: Some(1800.0),
        }
    }

    fn error(request: CreateGameRequest) -> String {
        validate_create_game_request(&request).unwrap_err().public_message
    }

    #[test]
    fn accepts_a_supported_public_game() {
        let game = validate_create_game_request(&valid()).unwrap();
        assert_eq!(game.game_type, GameType::Coinflip);
        assert_eq!(game.amount, 1_000_000);
        assert_eq!((game.min_players, game.max_players), (2, 4));
        assert_eq!(game.timeout_seconds, 1800);
    }

    #[test]
    fn accepts_a_one_player_minimum_giveaway() {
        let game = validate_create_game_request(&CreateGameRequest {
            game_type: Some("giveaway".into()),
            min_players: Some(1.0),
            max_players: Some(10.0),
            ..valid()
        })
        .unwrap();
        assert_eq!((game.game_type, game.min_players, game.max_players), (GameType::Giveaway, 1, 10));
    }

    #[test]
    fn accepts_dynamically_configured_token_addresses_and_rejects_unsafe_bounds() {
        let game =
            validate_create_game_request(&CreateGameRequest { token_mint: Some(CREATOR.into()), ..valid() }).unwrap();
        assert_eq!(game.token_mint, Address::parse(CREATOR).unwrap());
        assert_eq!(error(CreateGameRequest { max_players: Some(101.0), ..valid() }), "Player limits are invalid");
        assert_eq!(
            error(CreateGameRequest { amount: Some("18446744073709551616".into()), ..valid() }),
            "Amount is too large"
        );
    }

    #[test]
    fn normalizes_malformed_solana_addresses_to_a_safe_validation_error() {
        assert_eq!(
            error(CreateGameRequest { creator: Some("z".repeat(44)), ..valid() }),
            "Invalid creator or token address"
        );
    }

    #[test]
    fn reports_each_validation_failure() {
        assert_eq!(error(CreateGameRequest { game_type: Some("lottery".into()), ..valid() }), "Invalid game type");
        assert_eq!(error(CreateGameRequest { amount: Some("1.5".into()), ..valid() }), "Invalid amount");
        assert_eq!(error(CreateGameRequest { amount: None, ..valid() }), "Invalid amount");
        assert_eq!(error(CreateGameRequest { amount: Some("000".into()), ..valid() }), "Amount must be positive");
        assert_eq!(
            error(CreateGameRequest { min_players: Some(2.5), ..valid() }),
            "Player limits must be whole numbers"
        );
        assert_eq!(error(CreateGameRequest { min_players: Some(1.0), ..valid() }), "Player limits are invalid");
        assert_eq!(
            error(CreateGameRequest { timeout_seconds: Some(59.0), ..valid() }),
            "Timeout must be between 1 minute and 24 hours"
        );
        assert_eq!(
            error(CreateGameRequest { timeout_seconds: None, ..valid() }),
            "Timeout must be between 1 minute and 24 hours"
        );
    }

    #[test]
    fn the_request_schema_is_strict_and_refined() {
        let body = json!({
            "creator": CREATOR, "tokenMint": TIMBA_MINT, "type": "coinflip", "amount": "5",
            "minPlayers": 2, "maxPlayers": 2.0, "timeoutSeconds": 600
        });
        let parsed = parse_create_game_request(&body).unwrap();
        assert_eq!(parsed.max_players, Some(2.0));
        let with = |key: &str, value: Value| {
            let mut changed = body.clone();
            changed[key] = value;
            parse_create_game_request(&changed)
        };
        assert!(with("extra", json!(1)).is_none());
        assert!(with("amount", json!("0")).is_none());
        assert!(with("amount", json!(5)).is_none());
        assert!(with("minPlayers", json!(1)).is_none());
        assert!(with("maxPlayers", json!(1)).is_none());
        assert!(with("maxPlayers", json!(101)).is_none());
        assert!(with("timeoutSeconds", json!(600.5)).is_none());
        assert!(with("type", json!("lottery")).is_none());
        assert!(with("creator", json!("nope")).is_none());
        assert!(parse_create_game_request(&json!([])).is_none());
        let mut missing = body.clone();
        missing.as_object_mut().unwrap().remove("timeoutSeconds");
        assert!(parse_create_game_request(&missing).is_none());
        assert!(with("type", json!("giveaway")).is_some());
    }
}
