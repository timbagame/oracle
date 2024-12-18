use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig,
        pubkey::Pubkey,
        signature::{Keypair, read_keypair_file},
        signer::Signer,
        system_program,
    },
    Client, Program,
};
use std::{rc::Rc, str::FromStr, time::Duration};
use tokio::time;
use rand::Rng;

// Program ID from your Anchor.toml
const PROGRAM_ID: &str = "BzU9WwzqMoDSTTdTurweMLp2tAciFpZaNL2bPUitwNyy";

#[derive(Debug)]
struct Game {
    address: Pubkey,
    status: u8,
    participants: Vec<Pubkey>,
    max_participants: u8,
    min_participants: u8,
    created_at: i64,
    timeout_duration: i64,
    oracle_hash: Option<[u8; 32]>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load operator keypair from file
    let operator = read_keypair_file("operator.json")?;
    
    // Initialize Solana client
    let url = "https://api.devnet.solana.com".to_string();
    let client = Client::new_with_options(
        url.clone(),
        Rc::new(operator.clone()),
        CommitmentConfig::confirmed(),
    );

    // Get program
    let program = client.program(Pubkey::from_str(PROGRAM_ID)?);

    println!("Starting operator bot...");
    println!("Operator pubkey: {}", operator.pubkey());

    loop {
        // Fetch all games
        match program.accounts::<Game>(vec![]) {
            Ok(games) => {
                for game in games {
                    let game_data = game.1;
                    
                    // Check if game is ready for oracle hash
                    if is_ready_for_oracle(&game_data) && game_data.oracle_hash.is_none() {
                        println!("Found game ready for oracle hash: {}", game.0);
                        
                        // Generate random hash
                        let mut rng = rand::thread_rng();
                        let mut hash_value = [0u8; 32];
                        rng.fill(&mut hash_value);

                        // Set oracle hash
                        match program
                            .request()
                            .accounts(set_oracle_hash_accounts(
                                game.0,
                                operator.pubkey(),
                            ))
                            .args("set_oracle_hash".to_string(), hash_value)
                            .signer(&operator)
                            .send() {
                                Ok(_) => println!("Successfully set oracle hash for game {}", game.0),
                                Err(e) => println!("Error setting oracle hash: {}", e),
                            }
                    }
                }
            }
            Err(e) => println!("Error fetching games: {}", e),
        }

        // Sleep for a bit before next iteration
        time::sleep(Duration::from_secs(1)).await;
    }
}

fn is_ready_for_oracle(game: &Game) -> bool {
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    game.participants.len() == game.max_participants as usize
        || (game.participants.len() >= game.min_participants as usize
            && current_time >= game.created_at + game.timeout_duration)
}

fn set_oracle_hash_accounts(game: Pubkey, operator: Pubkey) -> Vec<(&'static str, Pubkey)> {
    vec![
        ("game", game),
        ("config", get_config_address()),
        ("oracle", operator),
        ("recentBlockhash", system_program::ID),
    ]
}

fn get_config_address() -> Pubkey {
    // You'll need to replace this with your actual config address
    // This is just a placeholder
    Pubkey::from_str("Config111111111111111111111111111111111111111").unwrap()
} 