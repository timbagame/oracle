//! Port of `tests/evm-service.test.ts` against an in-memory chain.

mod common;

use std::sync::Arc;

use alloy_consensus::transaction::SignerRecoverable;
use alloy_consensus::TxEnvelope;
use alloy_eips::eip2718::Decodable2718;
use alloy_primitives::{keccak256, Bytes, B256, U256};
use alloy_sol_types::{SolCall, SolEvent, SolValue};
use common::*;
use serde_json::{json, Value};
use timba_evm_oracle::config::EvmConfig;
use timba_evm_oracle::protocol::abi::{completeGameCall, CreateRequest, PlayerJoined};
use timba_evm_oracle::protocol::client::{
    commitment_for, complete_game_transaction, creation_digest, game_id_for, private_join_digest,
};
use timba_evm_oracle::protocol::schema::parse_bytes32;
use timba_evm_oracle::rpc::{recover_address, RpcError};
use timba_evm_oracle::store::{PendingTransaction, StoredGame};

fn reverted() -> RpcError {
    RpcError::Node { code: 3, message: "execution reverted".into(), data: Some(json!("0x")) }
}

async fn error_of<T: std::fmt::Debug>(future: impl std::future::Future<Output = anyhow::Result<T>>) -> String {
    future.await.unwrap_err().to_string()
}

mod validate_deployment {
    use super::*;

    #[tokio::test]
    async fn accepts_a_proxy_owned_by_the_operator_on_the_configured_chain() {
        let fake = setup();
        fake.service.validate_deployment().await.unwrap();
    }

    #[tokio::test]
    async fn rejects_an_rpc_endpoint_on_another_chain() {
        let fake = setup();
        fake.chain.state().chain_id = 1;
        let error = error_of(fake.service.validate_deployment()).await;
        assert_eq!(error, "EVM RPC chain mismatch");
    }

    #[tokio::test]
    async fn rejects_a_proxy_owned_by_someone_else() {
        let fake = setup();
        fake.chain.state().owner = creator();
        let error = error_of(fake.service.validate_deployment()).await;
        assert_eq!(error, "EVM operator does not own configured proxy");
    }
}

mod authorize {
    use super::*;

    fn validator_requests(fake: &Fake) -> Vec<Value> {
        fake.chain.calls("eth_call").into_iter().filter(|params| params[0].get("to").is_none()).collect()
    }

    #[tokio::test]
    async fn signs_the_creators_terms_with_a_fresh_commitment_and_stores_the_secret() {
        let fake = setup();
        let input = creation_intent(&fake, json!({}));

        let result = fake.service.authorize(&input).await.unwrap();

        let game_id = game_id_for(&fake.service.deployment, creator(), U256::ZERO).unwrap();
        assert_eq!(result.game_id, game_id);
        let stored = fake.service.store().game(&game_id.to_string()).unwrap().unwrap();
        let secret = parse_bytes32(&stored.secret).unwrap();
        assert_eq!(result.request["commitment"], commitment_for(secret).to_string());
        assert_eq!(result.request["amount"], "100");
        assert_eq!(stored.signature, result.signature.to_string());
        assert_eq!(stored.request, result.request.to_string());
        let mut intent: Value = serde_json::from_str(&stored.intent).unwrap();
        assert_eq!(intent["deadline"], "0");
        assert_eq!(intent["commitment"], B256::ZERO.to_string());
        intent["deadline"] = input["deadline"].clone();
        intent["commitment"] = result.request["commitment"].clone();
        assert_eq!(intent, result.request);

        let request = CreateRequest {
            creator: creator(),
            token: TOKEN,
            gameType: 0,
            amount: U256::from(100),
            minPlayers: 2,
            maxPlayers: 2,
            timeout: 3600,
            isPrivate: false,
            commitment: commitment_for(secret),
            nonce: U256::ZERO,
            deadline: U256::from(1_120),
        };
        let digest = creation_digest(&fake.service.deployment, &request).unwrap();
        assert_eq!(recover_address(digest, &result.signature), Some(operator()));
        // The creator's proof is checked for the creator's address through the universal validator.
        let validator = validator_requests(&fake);
        assert_eq!(validator.len(), 1);
        let data = validator[0][0]["data"].as_str().unwrap().to_lowercase();
        let proof = input["proof"].as_str().unwrap().trim_start_matches("0x").to_string();
        assert!(data.contains(&hex::encode(creator())));
        assert!(data.contains(&proof));
    }

    #[tokio::test]
    async fn serializes_the_authorized_request_like_the_typescript_service() {
        let fake = setup();
        let result = fake.service.authorize(&creation_intent(&fake, json!({}))).await.unwrap();
        let keys: Vec<&str> = result.request.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "creator",
                "token",
                "gameType",
                "amount",
                "minPlayers",
                "maxPlayers",
                "timeout",
                "isPrivate",
                "nonce",
                "deadline",
                "commitment"
            ]
        );
        assert_eq!(result.request["creator"], creator().to_checksum(None));
        let body = result.to_json();
        assert_eq!(body["gameId"], result.game_id.to_string());
        assert_eq!(body["signature"].as_str().unwrap().len(), 132);
    }

    #[tokio::test]
    async fn reuses_the_stored_secret_when_the_same_nonce_is_authorized_again() {
        let fake = setup();
        let first = fake.service.authorize(&creation_intent(&fake, json!({}))).await.unwrap();
        let second = fake.service.authorize(&creation_intent(&fake, json!({ "amount": "150" }))).await.unwrap();

        assert_eq!(second.game_id, first.game_id);
        assert_eq!(second.request["commitment"], first.request["commitment"]);
        let stored = fake.service.store().game(&first.game_id.to_string()).unwrap().unwrap();
        let request: Value = serde_json::from_str(&stored.request).unwrap();
        assert_eq!(request["amount"], "150");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_authorizations_of_one_nonce_share_the_stored_secret() {
        let fake = setup();
        let requests = (0..16).map(|index| {
            let service = fake.service.clone();
            let input = creation_intent(&fake, json!({ "amount": (150 + index).to_string() }));
            tokio::spawn(async move { service.authorize(&input).await.unwrap() })
        });
        let results = futures::future::join_all(requests).await;

        let stored = fake.service.store().game(&results[0].as_ref().unwrap().game_id.to_string()).unwrap().unwrap();
        let commitment = commitment_for(parse_bytes32(&stored.secret).unwrap()).to_string();
        for result in results {
            assert_eq!(result.unwrap().request["commitment"], commitment);
        }
    }

    #[tokio::test]
    async fn rejects_deadlines_outside_the_five_minute_authorization_window() {
        let fake = setup();
        let now = fake.chain.state().now;
        for deadline in [now + 301, now] {
            let input = creation_intent(&fake, json!({ "deadline": deadline.to_string() }));
            let error = error_of(fake.service.authorize(&input)).await;
            assert_eq!(error, "Authorization expires within five minutes");
        }
    }

    #[tokio::test]
    async fn rejects_timeouts_and_player_counts_beyond_the_oracle_limits() {
        let fake = setup();
        let input = creation_intent(&fake, json!({ "maxPlayers": 11 }));
        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Game exceeds current oracle limits");

        fake.chain.state().limits = [5, 600, 4000, 86_400, 10];
        let input = creation_intent(&fake, json!({}));
        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Game exceeds current oracle limits");
    }

    #[tokio::test]
    async fn rejects_amounts_below_the_token_minimum_and_impossible_player_bounds() {
        let fake = setup();
        for overrides in [
            json!({ "amount": "99" }),
            json!({ "minPlayers": 1 }),
            json!({ "minPlayers": 3 }),
            json!({ "amount": U256::MAX.to_string() }),
        ] {
            let input = creation_intent(&fake, overrides);
            let error = error_of(fake.service.authorize(&input)).await;
            assert_eq!(error, "Invalid game terms");
        }
    }

    #[tokio::test]
    async fn rejects_tokens_without_an_oracle_policy() {
        let fake = setup();
        let input = creation_intent(&fake, json!({ "token": "0x3333333333333333333333333333333333333333" }));
        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Unsupported EVM token");
    }

    #[tokio::test]
    async fn rejects_a_proof_not_signed_by_the_creator() {
        let fake = setup();
        let mut input = creation_intent(&fake, json!({}));
        let other = creation_intent(&fake, json!({ "amount": "101" }));
        input["proof"] = other["proof"].clone();

        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Invalid creator proof");
        assert!(fake.service.store().games().unwrap().is_empty());
    }

    #[tokio::test]
    async fn accepts_smart_account_proofs_confirmed_by_the_validator() {
        let fake = setup();
        fake.chain.state().validator = Ok(format!("0x{}", "0".repeat(63) + "1"));
        let mut input = creation_intent(&fake, json!({}));
        input["proof"] = json!(format!("0x{}", "ab".repeat(100)));

        let result = fake.service.authorize(&input).await.unwrap();
        assert_eq!(result.request["amount"], "100");
    }

    #[tokio::test]
    async fn falls_back_to_ecdsa_when_the_validator_call_fails() {
        let fake = setup();
        fake.chain.state().validator = Err(RpcError::Http("validator unavailable".into()));
        fake.service.authorize(&creation_intent(&fake, json!({}))).await.unwrap();
        let mut input = creation_intent(&fake, json!({}));
        input["proof"] = json!(format!("0x{}", "ab".repeat(65)));
        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Invalid creator proof");
    }

    #[tokio::test]
    async fn rejects_a_stale_creation_nonce() {
        let fake = setup();
        fake.chain.state().creation_nonce = U256::from(1);
        let input = creation_intent(&fake, json!({}));
        let error = error_of(fake.service.authorize(&input)).await;
        assert_eq!(error, "Creation nonce changed; reload wallet state");
    }

    #[tokio::test]
    async fn rejects_malformed_wire_input() {
        let fake = setup();
        let mut input = creation_intent(&fake, json!({}));
        input["secret"] = json!("never accepted");
        assert!(fake.service.authorize(&input).await.is_err());
        assert!(fake.chain.calls("eth_getBlockByNumber").is_empty());
    }
}

mod private_join {
    use super::*;

    fn game_id() -> B256 {
        B256::repeat_byte(0x44)
    }

    fn invitation(fake: &Fake, deadline: Option<u64>) -> Value {
        let deadline = deadline.unwrap_or(fake.chain.state().now + 60);
        let digest = private_join_digest(&fake.service.deployment, game_id(), player(), U256::from(deadline)).unwrap();
        json!({
            "gameId": game_id().to_string(),
            "player": player().to_checksum(None),
            "deadline": deadline.to_string(),
            "proof": account(CREATOR_KEY).sign_hash(digest).unwrap().to_string(),
        })
    }

    fn private_game(status: u8, is_private: bool) -> timba_evm_oracle::protocol::abi::Game {
        timba_evm_oracle::protocol::abi::Game { isPrivate: is_private, status, ..fake_game() }
    }

    #[tokio::test]
    async fn co_signs_an_invitation_approved_by_the_private_games_creator() {
        let fake = setup();
        fake.chain.state().games.insert(game_id(), private_game(1, true));
        let input = invitation(&fake, None);

        let result = fake.service.private_join(&input).await.unwrap();

        assert_eq!(result.deadline, input["deadline"].as_str().unwrap());
        let deadline = U256::from_str_radix(input["deadline"].as_str().unwrap(), 10).unwrap();
        let digest = private_join_digest(&fake.service.deployment, game_id(), player(), deadline).unwrap();
        assert_eq!(recover_address(digest, &result.signature), Some(operator()));
        assert_eq!(result.to_json(), json!({ "deadline": result.deadline, "signature": result.signature.to_string() }));
    }

    #[tokio::test]
    async fn rejects_invitations_outside_the_five_minute_window() {
        let fake = setup();
        fake.chain.state().games.insert(game_id(), private_game(1, true));
        let now = fake.chain.state().now;
        let input = invitation(&fake, Some(now + 301));
        let error = error_of(fake.service.private_join(&input)).await;
        assert_eq!(error, "Invitation expires within five minutes");
    }

    #[tokio::test]
    async fn rejects_public_or_already_settled_games() {
        let fake = setup();
        fake.chain.state().games.insert(game_id(), private_game(1, false));
        let error = error_of(fake.service.private_join(&invitation(&fake, None))).await;
        assert_eq!(error, "Private game unavailable");

        fake.chain.state().games.insert(game_id(), private_game(2, true));
        let error = error_of(fake.service.private_join(&invitation(&fake, None))).await;
        assert_eq!(error, "Private game unavailable");
    }

    #[tokio::test]
    async fn rejects_invitations_the_creator_did_not_sign() {
        let fake = setup();
        fake.chain.state().games.insert(game_id(), private_game(1, true));
        let mut input = invitation(&fake, None);
        let digest =
            private_join_digest(&fake.service.deployment, game_id(), player(), U256::from(fake.chain.state().now + 60))
                .unwrap();
        input["proof"] = json!(account(PLAYER_KEY).sign_hash(digest).unwrap().to_string());
        let error = error_of(fake.service.private_join(&input)).await;
        assert_eq!(error, "Invalid invitation");
    }
}

mod tick_settlement {
    use super::*;

    const GAME_A: B256 = B256::repeat_byte(0xa1);
    const GAME_B: B256 = B256::repeat_byte(0xb2);
    const SECRET_A: B256 = B256::repeat_byte(0xc3);
    const SECRET_B: B256 = B256::repeat_byte(0xd4);

    fn seed(fake: &Fake, id: B256, secret: B256, deadline: Option<u64>) {
        let deadline = deadline.unwrap_or(fake.chain.state().now + 60);
        fake.service
            .store()
            .save(&StoredGame {
                id: id.to_string(),
                secret: secret.to_string(),
                intent: "{}".into(),
                request: json!({ "deadline": deadline.to_string() }).to_string(),
                signature: "0x12".into(),
            })
            .unwrap();
    }

    fn simulations(fake: &Fake) -> Vec<completeGameCall> {
        fake.chain
            .contract_calls(completeGameCall::SELECTOR)
            .iter()
            .map(|params| {
                let data: Bytes = params[0]["data"].as_str().unwrap().parse().unwrap();
                completeGameCall::abi_decode(&data).unwrap()
            })
            .collect()
    }

    #[tokio::test]
    async fn submits_one_signed_completion_for_a_settleable_game_and_journals_it_first() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());

        fake.service.tick().await.unwrap();

        let simulated = simulations(&fake);
        assert_eq!(simulated.len(), 1);
        assert_eq!((simulated[0].gameId, simulated[0].secret), (GAME_A, SECRET_A));
        let simulation = &fake.chain.contract_calls(completeGameCall::SELECTOR)[0][0];
        assert_eq!(simulation["from"], operator().to_checksum(None));
        let estimate = &fake.chain.calls("eth_estimateGas")[0][0];
        let data = complete_game_transaction(&fake.service.deployment, GAME_A, SECRET_A).unwrap().data;
        assert_eq!(estimate["to"], PROXY.to_checksum(None));
        assert_eq!(estimate["data"], data.to_string());
        assert_eq!(estimate["nonce"], "0x7");

        let pending = fake.service.store().pending().unwrap().unwrap();
        assert_eq!(pending.game, GAME_A.to_string());
        let raw: Bytes = pending.raw.parse().unwrap();
        assert_eq!(pending.hash, keccak256(&raw).to_string());
        let envelope = TxEnvelope::decode_2718(&mut raw.as_ref()).unwrap();
        assert_eq!(envelope.recover_signer().unwrap(), operator());
        let TxEnvelope::Eip1559(signed) = envelope else { panic!("expected an EIP-1559 transaction") };
        let tx = signed.tx();
        assert_eq!((tx.nonce, tx.gas_limit, tx.chain_id), (7, 90_000, 31337));
        // 1.2 x base fee (1 gwei) + priority fee (1 gwei).
        assert_eq!(tx.max_fee_per_gas, 2_200_000_000);
        assert_eq!(tx.max_priority_fee_per_gas, 1_000_000_000);
        assert_eq!(tx.input, data);
        assert_eq!(fake.chain.calls("eth_sendRawTransaction"), [json!([pending.raw])]);
        assert!(!fake.service.last_cycle_failed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(fake.service.last_cycle_at.load(std::sync::atomic::Ordering::SeqCst) > 0);
    }

    #[tokio::test]
    async fn signs_legacy_transactions_on_chains_without_a_base_fee() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.on("eth_getBlockByNumber", |_| {
            Ok(json!({ "hash": format!("0x{}", "ab".repeat(32)), "timestamp": "0x3e8" }))
        });

        fake.service.tick().await.unwrap();

        let raw: Bytes = fake.service.store().pending().unwrap().unwrap().raw.parse().unwrap();
        let TxEnvelope::Legacy(signed) = TxEnvelope::decode_2718(&mut raw.as_ref()).unwrap() else {
            panic!("expected a legacy transaction")
        };
        // 1.2 x eth_gasPrice (2 gwei).
        assert_eq!(signed.tx().gas_price, 2_400_000_000);
        assert_eq!(signed.tx().chain_id, Some(31337));
    }

    #[tokio::test]
    async fn signs_what_eth_fill_transaction_returns_with_fee_headroom() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.on("eth_fillTransaction", |_| {
            Ok(json!({ "raw": "0x", "tx": {
                "type": "0x2", "nonce": "0xc", "gas": "0x1d4c0",
                "maxFeePerGas": "0xb2d05e00", "maxPriorityFeePerGas": "0x3b9aca00"
            }}))
        });

        fake.service.tick().await.unwrap();

        let fill = &fake.chain.calls("eth_fillTransaction")[0][0];
        let data = complete_game_transaction(&fake.service.deployment, GAME_A, SECRET_A).unwrap().data;
        assert_eq!(fill["from"], operator().to_checksum(None));
        assert_eq!((&fill["to"], &fill["data"]), (&json!(PROXY.to_checksum(None)), &json!(data.to_string())));
        for method in ["eth_estimateGas", "eth_getTransactionCount", "eth_maxPriorityFeePerGas", "eth_gasPrice"] {
            assert!(fake.chain.calls(method).is_empty(), "{method} was called");
        }
        let raw: Bytes = fake.service.store().pending().unwrap().unwrap().raw.parse().unwrap();
        let TxEnvelope::Eip1559(signed) = TxEnvelope::decode_2718(&mut raw.as_ref()).unwrap() else {
            panic!("expected an EIP-1559 transaction")
        };
        let tx = signed.tx();
        assert_eq!((tx.nonce, tx.gas_limit), (12, 120_000));
        // 1.2 x the node's 3 gwei cap; the tip is kept.
        assert_eq!((tx.max_fee_per_gas, tx.max_priority_fee_per_gas), (3_600_000_000, 1_000_000_000));
    }

    #[tokio::test]
    async fn fills_only_what_the_node_left_out() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.on("eth_fillTransaction", |_| Ok(json!({ "raw": "0x", "tx": { "type": "0x2", "nonce": "0x3" } })));

        fake.service.tick().await.unwrap();

        assert!(fake.chain.calls("eth_getTransactionCount").is_empty());
        assert_eq!(fake.chain.calls("eth_estimateGas")[0][0]["nonce"], "0x3");
        let raw: Bytes = fake.service.store().pending().unwrap().unwrap().raw.parse().unwrap();
        let TxEnvelope::Eip1559(signed) = TxEnvelope::decode_2718(&mut raw.as_ref()).unwrap() else {
            panic!("expected an EIP-1559 transaction")
        };
        assert_eq!((signed.tx().nonce, signed.tx().gas_limit), (3, 90_000));
        assert_eq!(signed.tx().max_fee_per_gas, 2_200_000_000);
    }

    #[tokio::test]
    async fn treats_a_reverting_fill_like_a_reverting_estimate() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        seed(&fake, GAME_B, SECRET_B, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.state().games.insert(GAME_B, fake_game());
        let mut fills = 0;
        fake.chain.on("eth_fillTransaction", move |_| {
            fills += 1;
            if fills == 1 {
                return Err(reverted());
            }
            Err(RpcError::Node { code: -32601, message: "method not found".into(), data: None })
        });

        fake.service.tick().await.unwrap();

        assert_eq!(fake.chain.calls("eth_fillTransaction").len(), 2);
        let pending = fake.service.store().pending().unwrap().unwrap();
        assert_eq!(pending.game, simulations(&fake)[1].gameId.to_string());
    }

    #[tokio::test]
    async fn skips_reverted_simulations_so_one_bad_game_cannot_starve_the_others() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        seed(&fake, GAME_B, SECRET_B, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.state().games.insert(GAME_B, fake_game());
        let chain = fake.chain.clone();
        let mut simulations_seen = 0;
        fake.chain.on("eth_call", move |params| {
            let data = params[0]["data"].as_str().unwrap();
            if data.starts_with(&format!("0x{}", hex::encode(completeGameCall::SELECTOR))) {
                simulations_seen += 1;
                if simulations_seen == 1 {
                    return Err(reverted());
                }
                return Ok(json!("0x"));
            }
            chain.default_answer("eth_call", params)
        });

        fake.service.tick().await.unwrap();

        let simulated = simulations(&fake);
        assert_eq!(simulated.len(), 2);
        let pending = fake.service.store().pending().unwrap().unwrap();
        assert_eq!(pending.game, simulated[1].gameId.to_string());
    }

    #[tokio::test]
    async fn refuses_to_sign_when_the_rpc_serves_another_chain() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        // The fallback moves to a node on another chain after the cycle validated the deployment.
        let calls = std::sync::atomic::AtomicUsize::new(0);
        fake.chain.on("eth_chainId", move |_| {
            let first = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            Ok(json!(if first { "0x7a69" } else { "0x1" }))
        });

        let error = error_of(fake.service.tick()).await;
        assert_eq!(error, "The current chain does not match the configured chain");
        assert_eq!(fake.service.store().pending().unwrap(), None);
        assert!(fake.chain.calls("eth_sendRawTransaction").is_empty());
    }

    #[tokio::test]
    async fn fails_the_cycle_on_unexpected_settlement_errors() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.on("eth_estimateGas", |_| Err(RpcError::Http("rpc offline".into())));

        let error = error_of(fake.service.tick()).await;
        assert!(error.contains("rpc offline"), "{error}");
        assert!(fake.service.last_cycle_failed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(fake.service.store().pending().unwrap(), None);
    }

    #[tokio::test]
    async fn skips_games_whose_gas_estimate_reverts() {
        let fake = setup();
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(GAME_A, fake_game());
        fake.chain.on("eth_estimateGas", |_| Err(reverted()));

        fake.service.tick().await.unwrap();
        assert_eq!(fake.service.store().pending().unwrap(), None);
    }

    #[tokio::test]
    async fn parks_finished_and_never_created_games_for_a_day_without_settling_them() {
        let fake = setup();
        let now = fake.chain.state().now;
        seed(&fake, GAME_A, SECRET_A, None);
        seed(&fake, GAME_B, SECRET_B, Some(now - 400));
        fake.chain.state().games.insert(GAME_A, timba_evm_oracle::protocol::abi::Game { status: 2, ..fake_game() });
        fake.chain.state().games.insert(GAME_B, timba_evm_oracle::protocol::abi::Game { status: 0, ..fake_game() });

        fake.service.tick().await.unwrap();

        assert!(simulations(&fake).is_empty());
        assert!(fake.service.store().games().unwrap().is_empty());
        let store = fake.service.store();
        let mut statement = store.db.prepare("SELECT next_check FROM authorizations").unwrap();
        let checks: Vec<i64> = statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(checks.len(), 2);
        for check in checks {
            assert!(check - timba_common::time::now_ms() > 86_000_000);
        }
    }

    #[tokio::test]
    async fn waits_for_games_that_cannot_be_settled_yet() {
        let fake = setup();
        let now = fake.chain.state().now;
        seed(&fake, GAME_A, SECRET_A, None);
        fake.chain.state().games.insert(
            GAME_A,
            timba_evm_oracle::protocol::abi::Game { participants: vec![creator()], expiresAt: now + 60, ..fake_game() },
        );

        fake.service.tick().await.unwrap();

        assert!(simulations(&fake).is_empty());
        assert_eq!(fake.service.store().pending().unwrap(), None);
        // Rechecked after one poll interval.
        assert!(fake.service.store().games().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ignores_a_tick_while_another_cycle_is_still_running() {
        let fake = setup();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *fake.chain.chain_id_gate.lock().unwrap() = Some(gate.clone());
        let service = fake.service.clone();
        let first = tokio::spawn(async move { service.tick().await });
        while fake.chain.calls("eth_chainId").is_empty() {
            tokio::task::yield_now().await;
        }

        fake.service.tick().await.unwrap();
        assert_eq!(fake.chain.calls("eth_chainId").len(), 1);
        gate.add_permits(10);
        first.await.unwrap().unwrap();
        assert_eq!(fake.chain.calls("eth_blockNumber").len(), 1);
    }
}

mod tick_pending {
    use super::*;

    fn pending() -> PendingTransaction {
        PendingTransaction {
            game: B256::repeat_byte(0xe5).to_string(),
            raw: "0xab".into(),
            hash: B256::repeat_byte(0xf6).to_string(),
        }
    }

    fn submit(fake: &Fake, receipt: Option<Value>, head: u64) {
        fake.service.store().submit(&pending()).unwrap();
        let mut state = fake.chain.state();
        state.receipt = receipt;
        state.head = head;
        drop(state);
        fake.chain.on("eth_sendRawTransaction", |_| Ok(json!(B256::repeat_byte(0xf6).to_string())));
    }

    #[tokio::test]
    async fn clears_the_journal_once_the_receipt_has_enough_confirmations() {
        let fake = setup();
        submit(&fake, Some(json!({ "status": "0x1", "blockNumber": "0xa" })), 11);

        fake.service.tick().await.unwrap();

        assert_eq!(fake.chain.calls("eth_getTransactionReceipt"), [json!([pending().hash])]);
        assert_eq!(fake.service.store().pending().unwrap(), None);
        assert!(fake.chain.calls("eth_sendRawTransaction").is_empty());
    }

    #[tokio::test]
    async fn clears_the_journal_for_a_confirmed_failed_transaction() {
        let fake = setup();
        submit(&fake, Some(json!({ "status": "0x0", "blockNumber": "0xa" })), 12);

        fake.service.tick().await.unwrap();

        assert_eq!(fake.service.store().pending().unwrap(), None);
    }

    #[tokio::test]
    async fn keeps_the_journal_until_the_confirmation_depth_is_reached() {
        let fake = setup();
        submit(&fake, Some(json!({ "status": "0x1", "blockNumber": "0xa" })), 10);

        fake.service.tick().await.unwrap();

        assert_eq!(fake.service.store().pending().unwrap(), Some(pending()));
    }

    #[tokio::test]
    async fn rebroadcasts_the_exact_signed_bytes_when_the_receipt_is_missing() {
        let fake = setup();
        submit(&fake, None, 1);

        fake.service.tick().await.unwrap();

        assert_eq!(fake.chain.calls("eth_sendRawTransaction"), [json!(["0xab"])]);
        assert_eq!(fake.service.store().pending().unwrap(), Some(pending()));
    }

    #[tokio::test]
    async fn fails_the_cycle_and_keeps_the_journal_with_an_invalid_confirmation_depth() {
        let fake = setup_with(EvmConfig { confirmations: 0, ..evm_config() });
        submit(&fake, Some(json!({ "status": "0x1", "blockNumber": "0xa" })), 11);

        let error = error_of(fake.service.tick()).await;
        assert_eq!(error, "Invalid confirmation depth");
        assert_eq!(fake.service.store().pending().unwrap(), Some(pending()));
    }

    #[tokio::test]
    async fn fails_the_cycle_when_the_receipt_lookup_errors() {
        let fake = setup();
        submit(&fake, None, 1);
        fake.chain.on("eth_getTransactionReceipt", |_| Err(RpcError::Http("rpc offline".into())));

        let error = error_of(fake.service.tick()).await;
        assert!(error.contains("rpc offline"), "{error}");
        assert!(fake.service.last_cycle_failed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(fake.service.store().pending().unwrap(), Some(pending()));
    }
}

mod index {
    use super::*;

    fn game_id() -> B256 {
        B256::repeat_byte(0x12)
    }

    fn joined_log(block: u64, address: alloy_primitives::Address) -> Value {
        let topics = [PlayerJoined::SIGNATURE_HASH, game_id(), player().into_word()];
        json!({
            "address": address.to_string().to_lowercase(),
            "blockHash": block_hash(block),
            "blockNumber": format!("{block:#x}"),
            "transactionHash": format!("0x{}", "99".repeat(32)),
            "logIndex": "0x0",
            "removed": false,
            "topics": topics.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "data": Bytes::from((U256::ZERO, U256::from(block)).abi_encode_params()).to_string(),
        })
    }

    fn log_ranges(fake: &Fake) -> Vec<(String, String)> {
        fake.chain
            .calls("eth_getLogs")
            .iter()
            .map(|params| {
                (
                    params[0]["fromBlock"].as_str().unwrap().to_string(),
                    params[0]["toBlock"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn does_nothing_before_the_chain_reaches_the_confirmation_depth() {
        let fake = setup();
        fake.chain.state().head = 1;

        fake.service.index().await.unwrap();

        assert!(fake.chain.calls("eth_getLogs").is_empty());
        assert_eq!(fake.service.store().cursor().unwrap(), None);
    }

    #[tokio::test]
    async fn stores_decoded_deployment_events_and_advances_the_cursor() {
        let fake = setup();
        let foreign = joined_log(3, alloy_primitives::Address::repeat_byte(0x44));
        {
            let mut state = fake.chain.state();
            state.head = 10;
            state.logs = vec![joined_log(3, PROXY), foreign];
        }

        fake.service.index().await.unwrap();

        assert_eq!(
            fake.chain.calls("eth_getLogs"),
            [json!([{ "address": PROXY.to_checksum(None), "fromBlock": "0x0", "toBlock": "0x9" }])]
        );
        let cursor = fake.service.store().cursor().unwrap().unwrap();
        assert_eq!((cursor.block, cursor.hash), (9, block_hash(9)));
        let events = fake.service.store().events(Some(&game_id().to_string())).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"]["kind"], "joined");
        assert_eq!(events[0]["event"]["player"], player().to_checksum(None));
        assert_eq!(events[0]["blockNumber"], "3");
        assert_eq!(events[0]["logIndex"], 0);
        assert_eq!(events[0]["transactionHash"], format!("0x{}", "99".repeat(32)));
        assert_eq!(events[0]["blockHash"], block_hash(3));
        let keys: Vec<&str> = events[0].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["transactionHash", "logIndex", "blockHash", "blockNumber", "event"]);
    }

    #[tokio::test]
    async fn scans_at_most_500_blocks_per_cycle_and_resumes_from_the_cursor() {
        let fake = setup();
        fake.chain.state().head = 2_000;

        fake.service.index().await.unwrap();
        fake.service.index().await.unwrap();

        assert_eq!(
            log_ranges(&fake),
            [("0x0".to_string(), "0x1f3".to_string()), ("0x1f4".to_string(), "0x3e7".to_string())]
        );
    }

    #[tokio::test]
    async fn starts_from_the_configured_block() {
        let chain = FakeChain::new();
        chain.state().head = 100;
        let mut config = evm_config();
        config.start_block = 50;
        let store = timba_evm_oracle::store::EvmStore::open(":memory:", "start").unwrap();
        let service = timba_evm_oracle::service::EvmService::with_transport(
            config,
            OPERATOR_KEY,
            store,
            Arc::new(FakeTransport(chain.clone())),
        )
        .unwrap();

        service.index().await.unwrap();

        let params = &chain.calls("eth_getLogs")[0][0];
        assert_eq!((params["fromBlock"].as_str(), params["toBlock"].as_str()), (Some("0x32"), Some("0x63")));
    }

    #[tokio::test]
    async fn stops_when_the_cursor_is_already_at_the_confirmed_head() {
        let fake = setup();
        fake.chain.state().head = 10;
        fake.service.index().await.unwrap();

        fake.service.index().await.unwrap();

        assert_eq!(fake.chain.calls("eth_getLogs").len(), 1);
    }

    #[tokio::test]
    async fn resets_the_index_after_a_confirmed_chain_reorganization() {
        let fake = setup();
        {
            let mut state = fake.chain.state();
            state.head = 10;
            state.logs = vec![joined_log(3, PROXY)];
        }
        fake.service.index().await.unwrap();
        assert_eq!(fake.service.store().events(None).unwrap().len(), 1);
        fake.chain.on("eth_getBlockByNumber", |_| {
            Ok(json!({ "hash": format!("0x{}", "ee".repeat(32)), "timestamp": "0x3e8" }))
        });

        fake.service.index().await.unwrap();

        assert_eq!(fake.service.store().cursor().unwrap(), None);
        assert!(fake.service.store().events(None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn discards_a_batch_whose_end_block_changed_while_logs_were_read() {
        let fake = setup();
        {
            let mut state = fake.chain.state();
            state.head = 10;
            state.logs = vec![joined_log(3, PROXY)];
        }
        let mut reads = 0;
        fake.chain.on("eth_getBlockByNumber", move |params| {
            reads += 1;
            let number = params[0].as_str().unwrap();
            let hash = if reads == 1 {
                block_hash(u64::from_str_radix(&number[2..], 16).unwrap())
            } else {
                format!("0x{}", "ee".repeat(32))
            };
            Ok(json!({ "hash": hash, "timestamp": "0x3e8" }))
        });

        fake.service.index().await.unwrap();

        assert_eq!(fake.service.store().cursor().unwrap(), None);
        assert!(fake.service.store().events(None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn fails_the_batch_on_removed_logs() {
        let fake = setup();
        let mut log = joined_log(3, PROXY);
        log["removed"] = json!(true);
        {
            let mut state = fake.chain.state();
            state.head = 10;
            state.logs = vec![log];
        }

        let error = error_of(fake.service.index()).await;
        assert_eq!(error, "Removed log requires rollback");
        assert_eq!(fake.service.store().cursor().unwrap(), None);
    }
}
