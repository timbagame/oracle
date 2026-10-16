//! Byte-for-byte parity with `@solana/kit` + `@timbagame/protocol` plans.
//! Fixtures are generated from the TypeScript packages (see fixtures/README).

use serde_json::Value;
use timba_protocol::contracts::{ContractVersion, GameType, PROGRAM_ID};
use timba_protocol::plans::{build_create_game_plan, ContractAdapter, CreateGameInput, GameInstructionInput};
use timba_protocol::transaction::{LegacyMessage, Transaction};
use timba_protocol::{Address, Instruction};

fn addr(s: &str) -> Address {
    Address::parse(s).unwrap()
}

fn tx(fee_payer: &Address, instructions: &[Instruction]) -> String {
    let blockhash = addr("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM");
    let message = LegacyMessage::compile(fee_payer, &blockhash, instructions).unwrap();
    Transaction::from_message(&message).to_base64()
}

#[test]
fn plans_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/plans.json")).unwrap();
    let creator = addr("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    let operator = addr("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
    let mint = addr("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    let sol = addr("So11111111111111111111111111111111111111112");
    for version in [ContractVersion::V0_2_0, ContractVersion::V0_3_0] {
        let expected = &fixture[version.as_str()];
        let plan = build_create_game_plan(
            &CreateGameInput {
                creator,
                token_mint: mint,
                game_type: GameType::Giveaway,
                amount: 123_456_789,
                min_players: 2,
                max_players: 10,
                timeout_seconds: 3600,
                random_hash: vec![7; 32],
                oracle_operator: operator,
            },
            version,
            &PROGRAM_ID,
        )
        .unwrap();
        assert_eq!(plan.game.to_base58(), expected["game"]);
        assert_eq!(tx(&creator, &plan.instructions), expected["create"], "create {version}");

        let adapter = ContractAdapter::new(version, PROGRAM_ID);
        let join = adapter
            .build_join_plan(&GameInstructionInput {
                game: plan.game,
                player: operator,
                token_mint: sol,
                token_amount: Some(5000),
                authority: None,
            })
            .unwrap();
        assert_eq!(tx(&operator, &join.instructions), expected["join"], "join {version}");
        let unjoin = adapter
            .build_unjoin_plan(&GameInstructionInput {
                game: plan.game,
                player: operator,
                token_mint: mint,
                token_amount: None,
                authority: Some(creator),
            })
            .unwrap();
        assert_eq!(tx(&creator, &unjoin.instructions), expected["unjoin"], "unjoin {version}");
        let close = adapter.build_close_plan(&plan.game, &creator, &mint).unwrap();
        assert_eq!(tx(&creator, &close.instructions), expected["close"], "close {version}");
    }
}

#[test]
fn completion_instruction_matches_typescript() {
    use timba_protocol::contracts::{complete_game_instruction, find_game_pda, CompleteGameInput};
    let fixture: Value = serde_json::from_str(include_str!("fixtures/complete.json")).unwrap();
    let operator = addr(fixture["operator"].as_str().unwrap());
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let version = match case["version"].as_str().unwrap() {
            "0.2.0" => ContractVersion::V0_2_0,
            _ => ContractVersion::V0_3_0,
        };
        let random_hash = [case["randomHash"].as_u64().unwrap() as u8; 32];
        let instruction = complete_game_instruction(
            version,
            &CompleteGameInput {
                game: find_game_pda(&random_hash, &PROGRAM_ID),
                token_mint: addr(case["mint"].as_str().unwrap()),
                oracle_operator: operator,
                winner: addr(case["winner"].as_str().unwrap()),
                creator: addr(case["creator"].as_str().unwrap()),
                random_hash,
                secret_key: [case["secretKey"].as_u64().unwrap() as u8; 32],
                winner_index: case["winnerIndex"].as_u64().unwrap() as u32,
            },
            &PROGRAM_ID,
        );
        assert_eq!(tx(&operator, &[instruction]), case["tx"], "{case}");
    }
}
