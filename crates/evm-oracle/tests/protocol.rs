//! Byte-for-byte conformance with the TypeScript protocol package and viem. The fixtures in
//! `fixtures/viem.json` were produced by `@timbagame/protocol` 0.14.2 with viem 2.57.7.

use alloy_primitives::{Address, Bytes, B256, U256};
use serde_json::Value;
use timba_evm_oracle::protocol::abi::{CreateRequest, ERC6492_VALIDATOR_BYTECODE};
use timba_evm_oracle::protocol::client::{
    commitment_for, complete_game_transaction, creation_digest, game_id_for, private_join_digest, EvmDeployment,
};
use timba_evm_oracle::protocol::events::{decode_evm_game_event, EvmLog};
use timba_evm_oracle::rpc::recover_address;
use timba_evm_oracle::wallet::{Fees, OperatorWallet, PreparedTransaction};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/viem.json")).unwrap()
}

fn key(n: u8) -> B256 {
    B256::with_last_byte(n)
}

fn deployment() -> EvmDeployment {
    EvmDeployment { chain_id: 31337, address: Address::repeat_byte(0x11), version: "0.1.0".into() }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn request(creator: Address) -> CreateRequest {
    CreateRequest {
        creator,
        token: Address::repeat_byte(0x22),
        gameType: 1,
        amount: U256::from(12_345_678_901_234_567_890u128),
        minPlayers: 1,
        maxPlayers: 10,
        timeout: 3600,
        isPrivate: true,
        commitment: B256::repeat_byte(0xab),
        nonce: U256::from(7),
        deadline: U256::from(1120),
    }
}

#[test]
fn accounts_and_identifiers_match_viem() {
    let fixtures = fixtures();
    let accounts: Vec<String> =
        (1..=3).map(|n| OperatorWallet::new(key(n)).unwrap().address().to_checksum(None)).collect();
    let expected: Vec<&str> = fixtures["addresses"].as_array().unwrap().iter().map(text).collect();
    assert_eq!(accounts, expected);
    let creator = OperatorWallet::new(key(2)).unwrap().address();
    let id = game_id_for(&deployment(), creator, U256::from(7)).unwrap();
    assert_eq!(id.to_string(), text(&fixtures["gameId"]));
    let commitment = commitment_for(B256::repeat_byte(0x22));
    assert_eq!(commitment.to_string(), text(&fixtures["commitment"]));
}

#[test]
fn typed_data_digests_and_signatures_match_viem() {
    let fixtures = fixtures();
    let operator = OperatorWallet::new(key(1)).unwrap();
    let creator = OperatorWallet::new(key(2)).unwrap();
    let player = OperatorWallet::new(key(3)).unwrap().address();

    let digest = creation_digest(&deployment(), &request(creator.address())).unwrap();
    assert_eq!(digest.to_string(), text(&fixtures["creationDigest"]));
    let signature = operator.sign_hash(digest).unwrap();
    assert_eq!(signature.to_string(), text(&fixtures["creationSignature"]));
    assert_eq!(recover_address(digest, &signature), Some(operator.address()));

    let game = B256::repeat_byte(0x44);
    let join = private_join_digest(&deployment(), game, player, U256::from(1060)).unwrap();
    assert_eq!(join.to_string(), text(&fixtures["joinDigest"]));
    assert_eq!(creator.sign_hash(join).unwrap().to_string(), text(&fixtures["joinSignature"]));
}

#[test]
fn domain_rejects_unsupported_deployments() {
    let mut unsupported = deployment();
    unsupported.version = "0.2.0".into();
    let error = game_id_for(&unsupported, Address::ZERO, U256::ZERO).unwrap_err();
    assert_eq!(error.to_string(), "Unsupported EVM contract version");
    let mut chain = deployment();
    chain.chain_id = 0;
    let error = game_id_for(&chain, Address::ZERO, U256::ZERO).unwrap_err();
    assert_eq!(error.to_string(), "Invalid EVM chain ID");
}

#[test]
fn settlement_transactions_match_viem_serialization() {
    let fixtures = fixtures();
    let operator = OperatorWallet::new(key(1)).unwrap();
    let transaction =
        complete_game_transaction(&deployment(), B256::repeat_byte(0x44), B256::repeat_byte(0xc3)).unwrap();
    assert_eq!(transaction.data.to_string(), text(&fixtures["completeData"]));
    let mut prepared = PreparedTransaction {
        chain_id: 31337,
        nonce: 7,
        to: transaction.to,
        data: transaction.data,
        gas: 90_000,
        fees: Fees::Eip1559 { max_fee_per_gas: 2_000_000_000, max_priority_fee_per_gas: 1_000_000_000 },
    };
    let raw = operator.sign_transaction(&prepared).unwrap();
    assert_eq!(raw.to_string(), text(&fixtures["eip1559"]));
    prepared.fees = Fees::Legacy { gas_price: 1_200_000_000 };
    let raw = operator.sign_transaction(&prepared).unwrap();
    assert_eq!(raw.to_string(), text(&fixtures["legacy"]));
}

#[test]
fn validator_call_matches_viem_deploy_data() {
    use alloy_sol_types::SolValue;
    let fixtures = fixtures();
    let creator = OperatorWallet::new(key(2)).unwrap().address();
    let digest: B256 = text(&fixtures["joinDigest"]).parse().unwrap();
    let signature: Bytes = text(&fixtures["joinSignature"]).parse().unwrap();
    let mut data = hex::decode(ERC6492_VALIDATOR_BYTECODE.trim_start_matches("0x")).unwrap();
    data.extend((creator, digest, signature).abi_encode_params());
    assert_eq!(Bytes::from(data).to_string(), text(&fixtures["validatorCall"]));
}

#[test]
fn decoded_events_match_the_protocol_json() {
    let fixtures = fixtures();
    for log in fixtures["logs"].as_array().unwrap() {
        let decoded = decode_evm_game_event(
            &deployment(),
            &EvmLog {
                chain_id: 31337,
                address: text(&log["address"]).parse().unwrap(),
                data: text(&log["data"]).parse().unwrap(),
                topics: log["topics"].as_array().unwrap().iter().map(|topic| text(topic).parse().unwrap()).collect(),
                removed: false,
            },
        )
        .unwrap();
        let json = decoded.map_or(Value::Null, |event| event.to_json());
        // Compare serialized text so key order is checked too.
        assert_eq!(json.to_string(), log["decoded"].to_string(), "{}", log["eventName"]);
    }
}

#[test]
fn event_decoding_guards_chain_address_and_removal() {
    let fixtures = fixtures();
    let joined = &fixtures["logs"][2];
    let log = EvmLog {
        chain_id: 31337,
        address: Address::repeat_byte(0x11),
        data: text(&joined["data"]).parse().unwrap(),
        topics: joined["topics"].as_array().unwrap().iter().map(|topic| text(topic).parse().unwrap()).collect(),
        removed: false,
    };
    let other_chain = EvmLog { chain_id: 1, ..log.clone() };
    let error = decode_evm_game_event(&deployment(), &other_chain).unwrap_err();
    assert_eq!(error.to_string(), "Log belongs to another chain");
    let foreign = EvmLog { address: Address::repeat_byte(0x44), ..log.clone() };
    assert_eq!(decode_evm_game_event(&deployment(), &foreign).unwrap(), None);
    let removed = EvmLog { removed: true, ..log.clone() };
    let error = decode_evm_game_event(&deployment(), &removed).unwrap_err();
    assert_eq!(error.to_string(), "Removed log requires rollback");
    let unknown = EvmLog { topics: vec![B256::repeat_byte(0x99)], ..log.clone() };
    assert_eq!(decode_evm_game_event(&deployment(), &unknown).unwrap(), None);
    let truncated = EvmLog { data: Bytes::from(vec![0u8; 32]), ..log.clone() };
    assert!(decode_evm_game_event(&deployment(), &truncated).is_err());
    let missing_topic = EvmLog { topics: log.topics[..2].to_vec(), ..log };
    assert!(decode_evm_game_event(&deployment(), &missing_topic).is_err());
}
