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
