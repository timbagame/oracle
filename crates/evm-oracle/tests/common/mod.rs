//! An in-memory chain answering the oracle's JSON-RPC calls, plus fixtures shared by the
//! service, server and process tests. Signing stays real (local keys).

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{SolCall, SolValue};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use timba_evm_oracle::config::EvmConfig;
use timba_evm_oracle::protocol::abi::{
    completeGameCall, configCall, configReturn, creationNoncesCall, getGameCall, ownerCall, CreateRequest, Game,
};
use timba_evm_oracle::protocol::client::creation_digest;
use timba_evm_oracle::protocol::schema::{parse_address, EvmToken};
use timba_evm_oracle::rpc::{quantity, RpcError, Transport};
use timba_evm_oracle::service::EvmService;
use timba_evm_oracle::store::EvmStore;
use timba_evm_oracle::wallet::OperatorWallet;

pub const OPERATOR_KEY: B256 = B256::with_last_byte(1);
pub const CREATOR_KEY: B256 = B256::with_last_byte(2);
pub const PLAYER_KEY: B256 = B256::with_last_byte(3);
pub const PROXY: Address = Address::repeat_byte(0x11);
pub const TOKEN: Address = Address::repeat_byte(0x22);

/// Oracle config tuple: feePercentage, buffer, minTimeout, maxTimeout, maxPlayers.
pub const ORACLE_LIMITS: [u32; 5] = [5, 600, 300, 86_400, 10];

pub fn account(key: B256) -> OperatorWallet {
    OperatorWallet::new(key).unwrap()
}

pub fn operator() -> Address {
    account(OPERATOR_KEY).address()
}

pub fn creator() -> Address {
    account(CREATOR_KEY).address()
}

pub fn player() -> Address {
    account(PLAYER_KEY).address()
}

pub fn evm_config() -> EvmConfig {
    EvmConfig {
        chain_id: 31337,
        address: PROXY,
        version: "0.1.0".into(),
        rpc_urls: vec!["http://127.0.0.1:1".into()],
        start_block: 0,
        confirmations: 2,
        poll_ms: 250,
        database: ":memory:".into(),
        operator_key_file: "unused".into(),
        api_token_file: "unused".into(),
        port: 3002,
        tokens: vec![EvmToken { address: TOKEN, symbol: "TEST".into(), decimals: 18, minimum_amount: "100".into() }],
    }
}

pub fn fake_game() -> Game {
    Game {
        creator: creator(),
        token: TOKEN,
        gameType: 0,
        status: 1,
        isPrivate: false,
        minPlayers: 2,
        maxPlayers: 2,
        expiresAt: 10_000,
        ticketAmount: U256::from(100),
        totalAmount: U256::from(200),
        commitment: B256::ZERO,
        lastEntryBlock: U256::from(5),
        participants: vec![creator(), player()],
    }
}

pub fn block_hash(number: u64) -> String {
    format!("0x{number:064x}")
}

type Handler = Box<dyn FnMut(&Value) -> Result<Value, RpcError> + Send>;

pub struct ChainState {
    pub now: u64,
    pub chain_id: u64,
    pub owner: Address,
    pub limits: [u32; 5],
    pub creation_nonce: U256,
    pub games: HashMap<B256, Game>,
    /// What the ERC-6492 validator `eth_call` returns.
    pub validator: Result<String, RpcError>,
    pub head: u64,
    pub logs: Vec<Value>,
    pub receipt: Option<Value>,
    /// Every request received, in order.
    pub calls: Vec<(String, Value)>,
}

pub struct FakeChain {
    pub state: Mutex<ChainState>,
    overrides: Mutex<HashMap<String, Handler>>,
    /// While set, `eth_chainId` waits for a permit (used to hold a cycle open).
    pub chain_id_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
}

impl FakeChain {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ChainState {
                now: 1_000,
                chain_id: 31337,
                owner: operator(),
                limits: ORACLE_LIMITS,
                creation_nonce: U256::ZERO,
                games: HashMap::new(),
                validator: Ok("0x00".into()),
                head: 1,
                logs: Vec::new(),
                receipt: None,
                calls: Vec::new(),
            }),
            overrides: Mutex::new(HashMap::new()),
            chain_id_gate: Mutex::new(None),
        })
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, ChainState> {
        self.state.lock().unwrap()
    }

    /// Replaces the default answer for `method`.
    pub fn on(&self, method: &str, handler: impl FnMut(&Value) -> Result<Value, RpcError> + Send + 'static) {
        self.overrides.lock().unwrap().insert(method.to_string(), Box::new(handler));
    }

    pub fn calls(&self, method: &str) -> Vec<Value> {
        self.state().calls.iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }

    /// `eth_call` requests to the proxy whose calldata starts with `selector`.
    pub fn contract_calls(&self, selector: [u8; 4]) -> Vec<Value> {
        let prefix = format!("0x{}", hex::encode(selector));
        self.calls("eth_call")
            .into_iter()
            .filter(|params| params[0]["data"].as_str().is_some_and(|data| data.starts_with(&prefix)))
            .collect()
    }

    fn answer(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        if let Some(handler) = self.overrides.lock().unwrap().get_mut(method) {
            return handler(params);
        }
        self.default_answer(method, params)
    }

    /// The in-memory chain's own answer, for overrides that only change some requests.
    pub fn default_answer(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        let state = self.state();
        Ok(match method {
            "eth_chainId" => json!(quantity(state.chain_id)),
            "eth_blockNumber" => json!(quantity(state.head)),
            "eth_getBlockByNumber" => {
                let hash = match params[0].as_str() {
                    Some("latest") => format!("0x{}", "ab".repeat(32)),
                    Some(number) => block_hash(u64::from_str_radix(&number[2..], 16).unwrap()),
                    None => unreachable!(),
                };
                json!({ "hash": hash, "timestamp": quantity(state.now), "baseFeePerGas": "0x3b9aca00" })
            }
            "eth_call" => return Self::call(&state, &params[0]),
            "eth_estimateGas" => json!(quantity(90_000u64)),
            "eth_getTransactionCount" => json!("0x7"),
            "eth_maxPriorityFeePerGas" => json!("0x3b9aca00"),
            "eth_gasPrice" => json!("0x77359400"),
            // Most public RPCs do not offer it (geth, anvil and some providers do).
            "eth_fillTransaction" => {
                return Err(RpcError::Node {
                    code: -32601,
                    message: "the method eth_fillTransaction does not exist/is not available".into(),
                    data: None,
                })
            }
            "eth_getLogs" => Value::Array(state.logs.clone()),
            "eth_getTransactionReceipt" => state.receipt.clone().unwrap_or(Value::Null),
            "eth_sendRawTransaction" => {
                let raw: Bytes = params[0].as_str().unwrap().parse().unwrap();
                json!(keccak256(&raw).to_string())
            }
            _ => return Err(RpcError::Http(format!("unexpected request {method}"))),
        })
    }

    fn call(state: &ChainState, request: &Value) -> Result<Value, RpcError> {
        let data: Bytes = request["data"].as_str().unwrap().parse().unwrap();
        if request.get("to").is_none() {
            return state.validator.clone().map(Value::from);
        }
        let selector: [u8; 4] = data[..4].try_into().unwrap();
        let encoded = match selector {
            ownerCall::SELECTOR => ownerCall::abi_encode_returns(&state.owner),
            configCall::SELECTOR => {
                let [fee, buffer, min_timeout, max_timeout, max_players] = state.limits;
                configCall::abi_encode_returns(&configReturn {
                    feePercentage: fee as u8,
                    buffer,
                    minTimeout: min_timeout,
                    maxTimeout: max_timeout,
                    maxPlayers: max_players,
                })
            }
            creationNoncesCall::SELECTOR => state.creation_nonce.abi_encode(),
            getGameCall::SELECTOR => {
                let id = getGameCall::abi_decode(&data).unwrap().gameId;
                match state.games.get(&id) {
                    Some(game) => getGameCall::abi_encode_returns(game),
                    None => return Err(RpcError::Http(format!("unknown game {id}"))),
                }
            }
            completeGameCall::SELECTOR => Vec::new(),
            _ => return Err(RpcError::Http("unexpected eth_call".into())),
        };
        Ok(json!(Bytes::from(encoded).to_string()))
    }
}

/// The oracle's view of a `FakeChain`.
pub struct FakeTransport(pub Arc<FakeChain>);

impl Transport for FakeTransport {
    fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        let chain = self.0.clone();
        let method = method.to_string();
        Box::pin(async move {
            chain.state().calls.push((method.clone(), params.clone()));
            if method == "eth_chainId" {
                let gate = chain.chain_id_gate.lock().unwrap().clone();
                if let Some(gate) = gate {
                    let _permit = gate.acquire().await.unwrap();
                }
            }
            chain.answer(&method, &params)
        })
    }
}

pub struct Fake {
    pub service: Arc<EvmService>,
    pub chain: Arc<FakeChain>,
    pub clock: Arc<AtomicI64>,
}

impl Fake {
    pub fn set_now_ms(&self, value: i64) {
        self.clock.store(value, Ordering::SeqCst);
    }
}

/// An `EvmService` whose RPC answers come from an in-memory chain. The clock follows real
/// time unless a test pins it with `set_now_ms`.
pub fn setup() -> Fake {
    setup_with(evm_config())
}

pub fn setup_with(config: EvmConfig) -> Fake {
    let chain = FakeChain::new();
    let store = EvmStore::open(":memory:", "fake-chain").unwrap();
    let clock = Arc::new(AtomicI64::new(0));
    let reader = clock.clone();
    let service = EvmService::with_transport(config, OPERATOR_KEY, store, Arc::new(FakeTransport(chain.clone())))
        .unwrap()
        .with_clock(Arc::new(move || match reader.load(Ordering::SeqCst) {
            0 => timba_common::time::now_ms(),
            pinned => pinned,
        }));
    Fake { service: Arc::new(service), chain, clock }
}

/// Creation terms signed by the creator with a zero commitment, as a wallet would send them.
pub fn creation_intent(fake: &Fake, overrides: Value) -> Value {
    let now = fake.chain.state().now;
    let mut wire = json!({
        "creator": creator().to_checksum(None),
        "token": TOKEN.to_checksum(None),
        "gameType": 0,
        "amount": "100",
        "minPlayers": 2,
        "maxPlayers": 2,
        "timeout": 3600,
        "isPrivate": false,
        "nonce": "0",
        "deadline": (now + 120).to_string(),
    });
    for (key, value) in overrides.as_object().unwrap() {
        wire[key] = value.clone();
    }
    let uint = |key: &str| U256::from_str_radix(wire[key].as_str().unwrap(), 10).unwrap();
    let request = CreateRequest {
        creator: parse_address(wire["creator"].as_str().unwrap()).unwrap(),
        token: parse_address(wire["token"].as_str().unwrap()).unwrap(),
        gameType: wire["gameType"].as_u64().unwrap() as u8,
        amount: uint("amount"),
        minPlayers: wire["minPlayers"].as_u64().unwrap() as u32,
        maxPlayers: wire["maxPlayers"].as_u64().unwrap() as u32,
        timeout: wire["timeout"].as_u64().unwrap() as u32,
        isPrivate: wire["isPrivate"].as_bool().unwrap(),
        commitment: B256::ZERO,
        nonce: uint("nonce"),
        deadline: uint("deadline"),
    };
    let digest = creation_digest(&fake.service.deployment, &request).unwrap();
    wire["proof"] = json!(account(CREATOR_KEY).sign_hash(digest).unwrap().to_string());
    wire
}
