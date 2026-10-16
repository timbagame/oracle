//! Public web game API: token configuration, game preparation and
//! submission, game lookup and finalized game verification (port of
//! `web-api/`).

pub mod api;
pub mod cache;
pub mod create_game_request;
pub mod game_token_config;
pub mod token_utils;
pub mod verification;

pub use api::WebGameApi;
pub use cache::VerificationLoader;
pub use create_game_request::{validate_create_game_request, CreateGameRequest, CreateGameValidationError};
pub use verification::{is_valid_signature, verify_game_transaction};

#[cfg(test)]
mod tests;
