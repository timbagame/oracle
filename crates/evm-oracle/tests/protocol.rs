//! Byte-for-byte conformance of the oracle's wallet, signatures and transactions with viem.
//! The fixtures in `fixtures/viem.json` were produced by `@timbagame/protocol` 0.14.2 with
//! viem 2.57.7. `timba-protocol` checks the protocol values themselves against its own package.

use alloy_primitives::{Address, Bytes, B256, U256};
use serde_json::Value;
use timba_evm_oracle::bytecode::ERC6492_VALIDATOR_BYTECODE;
use timba_evm_oracle::rpc::recover_address;
use timba_evm_oracle::wallet::{Fees, OperatorWallet, PreparedTransaction};
use timba_protocol::evm::abi::CreateRequest;
use timba_protocol::evm::client::{
    complete_game_transaction, creation_digest, game_id_for, private_join_digest, EvmDeployment,
};
use timba_protocol::evm::randomness::commitment_for;

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
