//! Authorization, invitation, settlement and indexing (port of `evm/service.ts`).

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::{keccak256, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use rand::RngCore;
use serde_json::{json, Value};

use crate::config::{token_policy, EvmConfig};
use crate::protocol::abi::{
    completeGameCall, configCall, configReturn, creationNoncesCall, getGameCall, ownerCall, CreateRequest, Game,
};
use crate::protocol::client::{
    commitment_for, complete_game_transaction, creation_digest, game_id_for, private_join_digest, EvmDeployment,
};
use crate::protocol::events::{decode_evm_game_event, EvmLog};
use crate::protocol::games::{
    game_lifecycle, observe_evm_game, transaction_progress, ActionProgress, EvmGameReference, ReceiptProgress,
};
use crate::protocol::schema::{parse_bytes32, parse_intent, parse_private_join, parse_uint};
use crate::rpc::{contract_error, is_contract_revert, CallRequest, FallbackTransport, PublicClient, Transport};
use crate::store::{EvmStore, IndexedEvent, PendingTransaction, StoredGame};
use crate::wallet::{estimate_fees, fill_transaction, OperatorWallet, PreparedTransaction};

/// Milliseconds since the epoch (`Date.now`), injectable for tests.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Maximum distance of a signed deadline from the latest block timestamp.
const DEADLINE_WINDOW_SECONDS: u64 = 300;
/// Blocks scanned per indexing cycle.
const INDEX_BATCH_BLOCKS: u64 = 500;
/// Finished or never-created games are rechecked daily.
const PARKED_GAME_MS: i64 = 86_400_000;

/// `{ gameId, request, signature }` returned by `POST /evm/authorize`.
#[derive(Debug, Clone, PartialEq)]
pub struct Authorization {
    pub game_id: B256,
    pub request: Value,
    pub signature: Bytes,
}

impl Authorization {
    pub fn to_json(&self) -> Value {
        json!({
            "gameId": self.game_id.to_string(),
            "request": self.request,
            "signature": self.signature.to_string(),
        })
    }
}

/// `{ deadline, signature }` returned by `POST /evm/private-join`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateJoinAuthorization {
    pub deadline: String,
    pub signature: Bytes,
}

impl PrivateJoinAuthorization {
    pub fn to_json(&self) -> Value {
        json!({ "deadline": self.deadline, "signature": self.signature.to_string() })
    }
}

/// The creation request as JSON, bigints as decimal strings (the persisted `request` shape).
pub fn request_json(request: &CreateRequest) -> Value {
    json!({
        "creator": request.creator.to_checksum(None),
        "token": request.token.to_checksum(None),
        "gameType": request.gameType,
        "amount": request.amount.to_string(),
        "minPlayers": request.minPlayers,
        "maxPlayers": request.maxPlayers,
        "timeout": request.timeout,
        "isPrivate": request.isPrivate,
        "nonce": request.nonce.to_string(),
        "deadline": request.deadline.to_string(),
        "commitment": request.commitment.to_string(),
    })
}

/// The decoded `getGame` tuple as JSON, bigints as decimal strings.
pub fn game_json(game: &Game) -> Value {
    json!({
        "creator": game.creator.to_checksum(None),
        "token": game.token.to_checksum(None),
        "gameType": game.gameType,
        "status": game.status,
        "isPrivate": game.isPrivate,
        "minPlayers": game.minPlayers,
        "maxPlayers": game.maxPlayers,
        "expiresAt": game.expiresAt.to_string(),
        "ticketAmount": game.ticketAmount.to_string(),
        "totalAmount": game.totalAmount.to_string(),
        "commitment": game.commitment.to_string(),
        "lastEntryBlock": game.lastEntryBlock.to_string(),
        "participants": game
            .participants
            .iter()
            .map(|participant| participant.to_checksum(None))
            .collect::<Vec<_>>(),
    })
}

/// Clears the cycle guard even when a cycle fails.
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct EvmService {
    pub config: EvmConfig,
    pub deployment: EvmDeployment,
    pub public_client: PublicClient,
    pub wallet: OperatorWallet,
    store: Mutex<EvmStore>,
    busy: AtomicBool,
    pub last_cycle_at: AtomicI64,
    pub last_cycle_failed: AtomicBool,
    clock: Clock,
}

impl EvmService {
    /// Connects to the configured RPC URLs in order.
    pub fn new(config: EvmConfig, key: B256, store: EvmStore) -> anyhow::Result<Self> {
        let transport = Arc::new(FallbackTransport::http(&config.rpc_urls));
        Self::with_transport(config, key, store, transport)
    }

    pub fn with_transport(
        config: EvmConfig,
        key: B256,
        store: EvmStore,
        transport: Arc<dyn Transport>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            deployment: config.deployment(),
            config,
            public_client: PublicClient::new(transport),
            wallet: OperatorWallet::new(key)?,
            store: Mutex::new(store),
            busy: AtomicBool::new(false),
            last_cycle_at: AtomicI64::new(0),
            last_cycle_failed: AtomicBool::new(false),
            clock: Arc::new(timba_common::time::now_ms),
        })
    }

    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    pub fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    pub fn store(&self) -> MutexGuard<'_, EvmStore> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Closes the database; the service must not be used afterwards.
    pub fn into_store(self) -> EvmStore {
        self.store.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn oracle_limits(&self) -> anyhow::Result<configReturn> {
        self.public_client.read_contract(self.config.address, &configCall {}).await
    }

    async fn latest_timestamp(&self) -> anyhow::Result<u64> {
        Ok(self.public_client.get_block(None).await?.timestamp)
    }

    pub async fn validate_deployment(&self) -> anyhow::Result<()> {
        if self.public_client.get_chain_id().await? != self.config.chain_id {
            anyhow::bail!("EVM RPC chain mismatch");
        }
        let owner = self.public_client.read_contract(self.config.address, &ownerCall {}).await?;
        if owner != self.wallet.address() {
            anyhow::bail!("EVM operator does not own configured proxy");
        }
        Ok(())
    }

    pub async fn authorize(&self, input: &Value) -> anyhow::Result<Authorization> {
        let parsed = parse_intent(input)?;
        let request = CreateRequest {
            creator: parsed.creator,
            token: parsed.token,
            gameType: parsed.game_type,
            amount: parsed.amount,
            minPlayers: parsed.min_players,
            maxPlayers: parsed.max_players,
            timeout: parsed.timeout,
            isPrivate: parsed.is_private,
            commitment: B256::ZERO,
            nonce: parsed.nonce,
            deadline: parsed.deadline,
        };
        let now = U256::from(self.latest_timestamp().await?);
        if request.deadline <= now || request.deadline > now + U256::from(DEADLINE_WINDOW_SECONDS) {
            anyhow::bail!("Authorization expires within five minutes");
        }
        let limits = self.oracle_limits().await?;
        if request.timeout < limits.minTimeout
            || request.timeout > limits.maxTimeout
            || request.maxPlayers > limits.maxPlayers
        {
            anyhow::bail!("Game exceeds current oracle limits");
        }
        let policy = token_policy(&self.config, request.token)?;
        let minimum = parse_uint(&policy.minimum_amount).unwrap_or(U256::MAX);
        let coinflip = request.gameType == 0;
        if request.amount < minimum
            || request.minPlayers < if coinflip { 2 } else { 1 }
            || request.maxPlayers < request.minPlayers
            || (coinflip && request.amount > U256::MAX / U256::from(request.maxPlayers))
        {
            anyhow::bail!("Invalid game terms");
        }
        let digest = creation_digest(&self.deployment, &request)?;
        if !self.public_client.verify_hash(request.creator, digest, &parsed.proof).await? {
            anyhow::bail!("Invalid creator proof");
        }
        let nonce = self
            .public_client
            .read_contract(self.config.address, &creationNoncesCall { creator: request.creator })
            .await?;
        if nonce != request.nonce {
            anyhow::bail!("Creation nonce changed; reload wallet state");
        }
        let game_id = game_id_for(&self.deployment, request.creator, request.nonce)?;
        let id = game_id.to_string();
        // One immutable secret per creator nonce, even if the creator changes an unsubmitted draft.
        // The contract permits only one creation at this nonce; previously signed alternatives
        // can never produce two games or reuse the reveal in a later nonce.
        let mut intent = request_json(&request);
        intent["deadline"] = json!("0");
        // Read, sign and persist under one lock (no yield) so concurrent requests share the secret.
        let store = self.store();
        let secret = match store.game(&id)? {
            Some(game) => game.secret,
            None => {
                let mut bytes = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut bytes);
                B256::from(bytes).to_string()
            }
        };
        let secret_bytes = parse_bytes32(&secret).ok_or_else(|| anyhow::anyhow!("Secret must be 32 bytes"))?;
        let authorized = CreateRequest { commitment: commitment_for(secret_bytes), ..request };
        let signature = self.wallet.sign_hash(creation_digest(&self.deployment, &authorized)?)?;
        let request = request_json(&authorized);
        store.save(&StoredGame {
            id: id.clone(),
            secret,
            intent: intent.to_string(),
            request: request.to_string(),
            signature: signature.to_string(),
        })?;
        Ok(Authorization { game_id, request, signature })
    }

    pub async fn private_join(&self, input: &Value) -> anyhow::Result<PrivateJoinAuthorization> {
        let request = parse_private_join(input)?;
        let deadline = parse_uint(&request.deadline).unwrap_or(U256::MAX);
        let now = U256::from(self.latest_timestamp().await?);
        if deadline <= now || deadline > now + U256::from(DEADLINE_WINDOW_SECONDS) {
            anyhow::bail!("Invitation expires within five minutes");
        }
        let game = self.game(request.game_id).await?;
        if !game.isPrivate || game.status != 1 {
            anyhow::bail!("Private game unavailable");
        }
        let digest = private_join_digest(&self.deployment, request.game_id, request.player, deadline)?;
        // A private invitation is explicitly approved by the game creator, not merely anyone with a link.
        if !self.public_client.verify_hash(game.creator, digest, &request.proof).await? {
            anyhow::bail!("Invalid invitation");
        }
        Ok(PrivateJoinAuthorization { deadline: request.deadline, signature: self.wallet.sign_hash(digest)? })
    }

    pub async fn game(&self, id: B256) -> anyhow::Result<Game> {
        self.public_client.read_contract(self.config.address, &getGameCall { gameId: id }).await
    }

    /// One oracle cycle; overlapping calls return immediately.
    pub async fn tick(&self) -> anyhow::Result<()> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _guard = BusyGuard(&self.busy);
        let result = self.cycle().await;
        self.last_cycle_at.store(self.now_ms(), Ordering::SeqCst);
        self.last_cycle_failed.store(result.is_err(), Ordering::SeqCst);
        result
    }

    async fn cycle(&self) -> anyhow::Result<()> {
        self.validate_deployment().await?;
        self.index().await?;
        let pending = self.store().pending()?;
        if let Some(pending) = pending {
            return self.follow_pending(&pending).await;
        }
        let block = self.public_client.get_block(None).await?;
        let limits = self.oracle_limits().await?;
        let games = self.store().games()?;
        for row in games {
            match self.settle(&row, block.timestamp, &limits).await {
                Ok(true) => break,
                Ok(false) => {}
                // One un-settleable token/game must not starve all other games.
                Err(error) if is_contract_revert(&error) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Clears a confirmed journal entry, or rebroadcasts the exact signed bytes.
    async fn follow_pending(&self, pending: &PendingTransaction) -> anyhow::Result<()> {
        let receipt = self.public_client.get_transaction_receipt(&pending.hash).await?;
        if let Some(receipt) = receipt {
            let head = self.public_client.get_block_number().await?;
            let progress = transaction_progress(
                Some(ReceiptProgress {
                    success: receipt.success,
                    confirmations: i128::from(head) - i128::from(receipt.block_number) + 1,
                }),
                self.config.confirmations,
            )?;
            if progress != ActionProgress::Submitted {
                self.store().clear_pending()?;
            }
        } else {
            // Preserve the exact signed transaction across transport failures and process restarts.
            // A rejected rebroadcast must degrade health while retaining the journal.
            self.public_client.send_raw_transaction(&pending.raw).await?;
        }
        Ok(())
    }

    /// Checks one authorization; `true` once a settlement transaction was journaled and sent.
    async fn settle(&self, row: &StoredGame, timestamp: u64, limits: &configReturn) -> anyhow::Result<bool> {
        self.store().defer(&row.id, self.config.poll_ms as i64)?;
        let id = parse_bytes32(&row.id).ok_or_else(|| anyhow::anyhow!("Invalid stored game id"))?;
        let account = self.game(id).await?;
        let never_created = || -> anyhow::Result<bool> {
            let deadline = serde_json::from_str::<Value>(&row.request)?
                .get("deadline")
                .and_then(Value::as_str)
                .and_then(parse_uint)
                .ok_or_else(|| anyhow::anyhow!("Cannot convert stored deadline to a BigInt"))?;
            Ok(U256::from(timestamp) > deadline + U256::from(DEADLINE_WINDOW_SECONDS))
        };
        if account.status == 2 || account.status == 3 || (account.status == 0 && never_created()?) {
            self.store().defer(&row.id, PARKED_GAME_MS)?;
        }
        let reference =
            EvmGameReference { chain_id: self.config.chain_id, deployment: self.config.address, game_id: id };
        let Some(game) = observe_evm_game(reference, &account)? else {
            return Ok(false);
        };
        if !game_lifecycle(&game, timestamp, u64::from(limits.buffer))?.can_settle {
            return Ok(false);
        }
        let secret = parse_bytes32(&row.secret).ok_or_else(|| anyhow::anyhow!("Secret must be 32 bytes"))?;
        let operator = self.wallet.address();
        self.public_client
            .simulate_contract(operator, self.config.address, &completeGameCall { gameId: id, secret })
            .await?;
        let transaction = complete_game_transaction(&self.deployment, id, secret)?;
        // viem prefers `eth_fillTransaction` and prepares each missing field itself otherwise.
        let request = CallRequest {
            from: Some(operator),
            to: Some(transaction.to),
            data: transaction.data.clone(),
            ..CallRequest::default()
        };
        let filled = fill_transaction(&self.public_client, &request)
            .await
            .map_err(|error| contract_error(completeGameCall::SIGNATURE, error))?
            .unwrap_or_default();
        let mut prepared = PreparedTransaction {
            chain_id: self.config.chain_id,
            nonce: match filled.nonce {
                Some(nonce) => nonce,
                None => self.public_client.get_transaction_count(operator).await?,
            },
            to: transaction.to,
            data: transaction.data,
            gas: 0,
            fees: match filled.fees {
                Some(fees) => fees,
                None => estimate_fees(&self.public_client).await?,
            },
        };
        prepared.gas = match filled.gas {
            Some(gas) => gas,
            None => self
                .public_client
                .estimate_gas(&prepared.call_request(operator))
                .await
                .map_err(|error| contract_error(completeGameCall::SIGNATURE, error))?,
        };
        // The wallet signs only for the chain the RPC currently serves.
        if self.public_client.get_chain_id().await? != self.config.chain_id {
            anyhow::bail!("The current chain does not match the configured chain");
        }
        let raw = self.wallet.sign_transaction(&prepared)?;
        let raw_hex = raw.to_string();
        self.store().submit(&PendingTransaction {
            game: row.id.clone(),
            raw: raw_hex.clone(),
            hash: keccak256(&raw).to_string(),
        })?;
        self.public_client.send_raw_transaction(&raw_hex).await?;
        Ok(true)
    }

    /// Indexes up to 500 confirmed blocks of deployment events.
    pub async fn index(&self) -> anyhow::Result<()> {
        let head = self.public_client.get_block_number().await?;
        let confirmations = u64::from(self.config.confirmations);
        if head < confirmations {
            return Ok(());
        }
        let target = head - confirmations + 1;
        let cursor = self.store().cursor()?;
        if let Some(cursor) = &cursor {
            let block = u64::try_from(cursor.block).unwrap_or(u64::MAX);
            let reorganized = block > target || self.public_client.get_block(Some(block)).await?.hash != cursor.hash;
            if reorganized {
                // Rebuild canonical events from deployment on a confirmed-chain reorganization.
                self.store().reset_index()?;
                return Ok(());
            }
        }
        let from = match &cursor {
            Some(cursor) => cursor.block as u64 + 1,
            None => self.config.start_block,
        };
        if from > target {
            return Ok(());
        }
        let to = (from + INDEX_BATCH_BLOCKS - 1).min(target);
        let end_block = self.public_client.get_block(Some(to)).await?;
        let logs = self.public_client.get_logs(self.config.address, from, to).await?;
        if self.public_client.get_block(Some(to)).await?.hash != end_block.hash {
            return Ok(());
        }
        let mut events = Vec::new();
        for log in &logs {
            let decoded = decode_evm_game_event(
                &self.deployment,
                &EvmLog {
                    chain_id: self.config.chain_id,
                    address: log.address,
                    data: log.data.clone(),
                    topics: log.topics.clone(),
                    removed: log.removed,
                },
            )?;
            if let Some(event) = decoded {
                events.push(IndexedEvent {
                    block: log.block_number as i64,
                    hash: log.transaction_hash.clone(),
                    log_index: log.log_index as i64,
                    data: json!({
                        "transactionHash": log.transaction_hash,
                        "logIndex": log.log_index,
                        "blockHash": log.block_hash,
                        "blockNumber": log.block_number.to_string(),
                        "event": event.to_json(),
                    })
                    .to_string(),
                });
            }
        }
        self.store().record_index(&events, to as i64, &end_block.hash)?;
        Ok(())
    }
}
