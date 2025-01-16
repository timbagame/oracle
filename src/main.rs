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
const PROGRAM_ID: &str = "2CnFDP6E2QNzD1QEcrNaZ29NArtrFWURQm4GmudXnZ9o";

#[derive(Debug)]
struct Game {
    address: Pubkey,
    creator: Pubkey,
    game_type: u8,
    amount: u64,
    max_players: u16,
    min_players: u16,
    players: Vec<Pubkey>,
    winner: Pubkey,
    status: u8,
    token_mint: Pubkey,
    created_at: u64,
    timeout: u32,
    is_private: bool,
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

    // Generate a secret key for games
    let mut rng = rand::thread_rng();
    let mut secret_key = [0u8; 64];
    rng.fill(&mut secret_key);

    loop {
        // Fetch all games
        match program.accounts::<Game>(vec![]) {
            Ok(games) => {
                for game in games {
                    let game_data = game.1;
                    
                    // Check if game is ready for completion
                    if is_ready_for_oracle(&game_data) {
                        println!("Found game ready for completion: {}", game.0);
                        
                        // Complete game with secret key
                        match program
                            .request()
                            .accounts(complete_game_accounts(
                                game.0,
                                operator.pubkey(),
                            ))
                            .args("complete_game", secret_key)
                            .signer(&operator)
                            .send() {
                                Ok(_) => println!("Successfully completed game {}", game.0),
                                Err(e) => println!("Error completing game: {}", e),
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
        .as_secs() as u64;

    game.status == 0 && // Active status
        (game.players.len() == game.max_players as usize
        || (game.players.len() >= game.min_players as usize
            && current_time >= game.created_at + game.timeout as u64))
}

fn complete_game_accounts(game: Pubkey, operator: Pubkey) -> Vec<(&'static str, Pubkey)> {
    vec![
        ("game", game),
        ("oracle", operator),
        ("authority", operator),
        ("player_balance", get_player_balance_address()),
        ("game_token", get_game_token_address()),
        ("system_program", system_program::ID),
        ("token_program", get_token_program_address()),
    ]
}

fn get_player_balance_address() -> Pubkey {
    // Replace with actual PDA derivation
    Pubkey::from_str("Balance111111111111111111111111111111111111111").unwrap()
}

fn get_game_token_address() -> Pubkey {
    // Replace with actual PDA derivation
    Pubkey::from_str("Token1111111111111111111111111111111111111111").unwrap()
}

fn get_token_program_address() -> Pubkey {
    // Replace with actual token program ID
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
} 