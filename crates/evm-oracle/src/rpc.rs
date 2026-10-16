//! Minimal EVM JSON-RPC client with the semantics the TypeScript service got from viem:
//! an ordered HTTP fallback transport (3 s per endpoint, no retries, no ranking),
//! typed contract reads, revert classification and ERC-6492 signature verification.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, Bytes, Signature, B256, U256};
use alloy_sol_types::{SolCall, SolValue};
use futures::future::BoxFuture;
use serde_json::{json, Value};

use crate::bytecode::{DEPLOYLESS_CALL_BYTECODE, ERC6492_VALIDATOR_BYTECODE, MULTICALL3_BYTECODE};
use crate::erc8010::{self, SignedAuthorization, Wrapped, ERC1271_MAGIC};

/// Per-endpoint request timeout (`http(url, { timeout: 3_000 })`).
pub const RPC_TIMEOUT: Duration = Duration::from_millis(3_000);

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RpcError {
    /// A JSON-RPC error object returned by a node.
    #[error("RPC request failed ({code}): {message}")]
    Node { code: i64, message: String, data: Option<Value> },
    /// HTTP status, timeout or connection failures.
    #[error("HTTP request failed: {0}")]
    Http(String),
    /// A response that does not match the method's result type.
    #[error("Invalid RPC response: {0}")]
    InvalidResponse(String),
}

impl RpcError {
    /// viem's fallback `shouldThrow`: deterministic rejections are not retried on the next URL.
    pub fn should_throw(&self) -> bool {
        match self {
            Self::Node { code, message, .. } => {
                matches!(code, -32003 | 4001 | 5000 | 7000)
                    || message.contains("execution reverted")
                    || message.contains("gas required exceeds allowance")
            }
            _ => false,
        }
    }

    /// viem's `ExecutionRevertedError` node match (code 3 or a revert message).
    pub fn is_execution_reverted(&self) -> bool {
        match self {
            Self::Node { code, message, .. } => {
                let message = message.to_lowercase();
                *code == 3
                    || message.contains("execution reverted")
                    || message.contains("gas required exceeds allowance")
            }
            _ => false,
        }
    }

    /// viem's `MethodNotFoundRpcError` / `MethodNotSupportedRpcError`, or a
    /// "<method> is not available" message.
    pub fn is_unsupported_method(&self, method: &str) -> bool {
        match self {
            Self::Node { code: -32601 | -32004, .. } => true,
            Self::Node { message, .. } => message.contains(&format!("{method} is not available")),
            _ => false,
        }
    }

    /// viem's `getContractError`: which node errors surface as `ContractFunctionRevertedError`.
    pub fn is_contract_revert(&self) -> bool {
        match self {
            Self::Node { code: 3 | -32603, .. } => true,
            Self::Node { code: -32000, message, data } => {
                message == "execution reverted"
                    && matches!(data, Some(value) if !value.is_null() && value.as_str() != Some(""))
            }
            _ => false,
        }
    }
}

/// A contract call or gas estimate rejected by the EVM (viem `ContractFunctionRevertedError`).
#[derive(Debug, thiserror::Error)]
#[error("The contract function \"{function}\" reverted: {source}")]
pub struct ContractRevertedError {
    pub function: &'static str,
    pub source: RpcError,
}

/// Classifies a failed contract interaction the way viem's contract actions do.
pub fn contract_error(function: &'static str, error: RpcError) -> anyhow::Error {
    if error.is_contract_revert() {
        ContractRevertedError { function, source: error }.into()
    } else {
        error.into()
    }
}

/// True when any cause in the chain is a contract revert (`BaseError.walk`).
pub fn is_contract_revert(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.downcast_ref::<ContractRevertedError>().is_some())
}

pub trait Transport: Send + Sync {
    fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>>;
}

/// One JSON-RPC HTTP endpoint.
pub struct HttpTransport {
    client: reqwest::Client,
    url: String,
    id: Arc<AtomicU64>,
}

impl HttpTransport {
    pub fn new(url: impl Into<String>) -> Self {
        let client = timba_common::http_client::client_builder()
            .timeout(RPC_TIMEOUT)
            .build()
            .expect("HTTP client configuration is valid");
        Self { client, url: url.into(), id: Arc::new(AtomicU64::new(0)) }
    }
}

impl Transport for HttpTransport {
    fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        let id = self.id.fetch_add(1, Ordering::Relaxed) + 1;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let request = self.client.post(&self.url).json(&body);
        Box::pin(async move {
            let response = request.send().await.map_err(|error| RpcError::Http(error.without_url().to_string()))?;
            let status = response.status();
            let text = response.text().await.map_err(|error| RpcError::Http(error.without_url().to_string()))?;
            if !status.is_success() {
                return Err(RpcError::Http(format!("HTTP status {}", status.as_u16())));
            }
            let mut reply: Value =
                serde_json::from_str(&text).map_err(|_| RpcError::InvalidResponse("response is not JSON".into()))?;
            if let Some(error) = reply.get("error").filter(|error| !error.is_null()) {
                return Err(RpcError::Node {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(-1),
                    message: error.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
                    data: error.get("data").cloned(),
                });
            }
            Ok(reply.get_mut("result").map(Value::take).unwrap_or(Value::Null))
        })
    }
}

/// Tries each transport in order; the next one is used only for non-deterministic failures.
pub struct FallbackTransport {
    transports: Vec<Arc<dyn Transport>>,
}

impl FallbackTransport {
    pub fn new(transports: Vec<Arc<dyn Transport>>) -> Self {
        assert!(!transports.is_empty(), "at least one transport is required");
        Self { transports }
    }

    pub fn http(urls: &[String]) -> Self {
        Self::new(urls.iter().map(|url| Arc::new(HttpTransport::new(url.clone())) as Arc<dyn Transport>).collect())
    }
}

impl Transport for FallbackTransport {
    fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
        let transports = self.transports.clone();
        let method = method.to_string();
        Box::pin(async move {
            let (last, rest) = transports.split_last().expect("at least one transport is required");
            for transport in rest {
                match transport.request(&method, params.clone()).await {
                    Err(error) if !error.should_throw() => continue,
                    result => return result,
                }
            }
            last.request(&method, params).await
        })
    }
}

/// A block header as far as the oracle reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub hash: String,
    pub timestamp: u64,
    pub base_fee_per_gas: Option<u128>,
}

/// A log as returned by `eth_getLogs`; hashes keep the node's spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcLog {
    pub address: Address,
    pub block_hash: String,
    pub block_number: u64,
    pub data: Bytes,
    pub log_index: u64,
    pub transaction_hash: String,
    pub topics: Vec<B256>,
    pub removed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Receipt {
    pub success: bool,
    pub block_number: u64,
}

/// Fields of a call or gas estimate (`formatTransactionRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallRequest {
    pub from: Option<Address>,
    pub to: Option<Address>,
    pub data: Bytes,
    pub nonce: Option<u64>,
    pub gas_price: Option<u128>,
    pub max_fee_per_gas: Option<u128>,
    pub max_priority_fee_per_gas: Option<u128>,
    pub eip1559: Option<bool>,
    pub authorization_list: Vec<SignedAuthorization>,
}

impl CallRequest {
    fn to_json(&self) -> Value {
        let mut request = serde_json::Map::new();
        if !self.authorization_list.is_empty() {
            let list = self.authorization_list.iter().map(SignedAuthorization::to_rpc).collect();
            request.insert("authorizationList".into(), Value::Array(list));
        }
        request.insert("data".into(), json!(self.data.to_string()));
        if let Some(from) = self.from {
            request.insert("from".into(), json!(from.to_checksum(None)));
        }
        if let Some(gas_price) = self.gas_price {
            request.insert("gasPrice".into(), json!(quantity(gas_price)));
        }
        if let Some(max_fee) = self.max_fee_per_gas {
            request.insert("maxFeePerGas".into(), json!(quantity(max_fee)));
        }
        if let Some(priority) = self.max_priority_fee_per_gas {
            request.insert("maxPriorityFeePerGas".into(), json!(quantity(priority)));
        }
        if let Some(nonce) = self.nonce {
            request.insert("nonce".into(), json!(quantity(nonce)));
        }
        if let Some(to) = self.to {
            request.insert("to".into(), json!(to.to_checksum(None)));
        }
        if let Some(eip1559) = self.eip1559 {
            request.insert("type".into(), json!(if eip1559 { "0x2" } else { "0x0" }));
        }
        Value::Object(request)
    }
}

/// `numberToHex`.
pub fn quantity(value: impl Into<u128>) -> String {
    format!("{:#x}", value.into())
}

fn parse_quantity(value: &Value, field: &str) -> Result<U256, RpcError> {
    value
        .as_str()
        .and_then(|text| text.strip_prefix("0x"))
        .and_then(|digits| U256::from_str_radix(if digits.is_empty() { "0" } else { digits }, 16).ok())
        .ok_or_else(|| RpcError::InvalidResponse(format!("{field} is not a quantity")))
}

pub(crate) fn parse_u64(value: &Value, field: &str) -> Result<u64, RpcError> {
    let number = parse_quantity(value, field)?;
    u64::try_from(number).map_err(|_| RpcError::InvalidResponse(format!("{field} is too large")))
}

pub(crate) fn parse_u128(value: &Value, field: &str) -> Result<u128, RpcError> {
    let number = parse_quantity(value, field)?;
    u128::try_from(number).map_err(|_| RpcError::InvalidResponse(format!("{field} is too large")))
}

fn parse_hex(value: &Value, field: &str) -> Result<Bytes, RpcError> {
    value
        .as_str()
        .and_then(|text| text.strip_prefix("0x"))
        .and_then(|digits| hex::decode(digits).ok())
        .map(Bytes::from)
        .ok_or_else(|| RpcError::InvalidResponse(format!("{field} is not hex")))
}

fn parse_string(value: &Value, field: &str) -> Result<String, RpcError> {
    value.as_str().map(str::to_string).ok_or_else(|| RpcError::InvalidResponse(format!("{field} is missing")))
}

fn parse_block(value: &Value) -> Result<Block, RpcError> {
    if value.is_null() {
        return Err(RpcError::InvalidResponse("Block could not be found".into()));
    }
    Ok(Block {
        hash: parse_string(&value["hash"], "block hash")?,
        timestamp: parse_u64(&value["timestamp"], "block timestamp")?,
        base_fee_per_gas: match value.get("baseFeePerGas") {
            Some(fee) if !fee.is_null() => Some(parse_u128(fee, "baseFeePerGas")?),
            _ => None,
        },
    })
}

fn parse_log(value: &Value) -> Result<RpcLog, RpcError> {
    let address = value["address"]
        .as_str()
        .and_then(timba_protocol::evm::schema::parse_address)
        .ok_or_else(|| RpcError::InvalidResponse("log address is invalid".into()))?;
    let topics = value["topics"]
        .as_array()
        .ok_or_else(|| RpcError::InvalidResponse("log topics are missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .and_then(timba_protocol::evm::schema::parse_bytes32)
                .ok_or_else(|| RpcError::InvalidResponse("log topic is invalid".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RpcLog {
        address,
        block_hash: parse_string(&value["blockHash"], "log blockHash")?,
        block_number: parse_u64(&value["blockNumber"], "log blockNumber")?,
        data: parse_hex(&value["data"], "log data")?,
        log_index: parse_u64(&value["logIndex"], "log logIndex")?,
        transaction_hash: parse_string(&value["transactionHash"], "log transactionHash")?,
        topics,
        removed: value["removed"].as_bool().unwrap_or(false),
    })
}

/// Read-side client (viem `PublicClient`) over any transport.
#[derive(Clone)]
pub struct PublicClient {
    transport: Arc<dyn Transport>,
    /// Set once the node rejects `eth_fillTransaction` as unknown (viem `supportsFillTransaction`).
    fill_unsupported: Arc<AtomicBool>,
}

impl PublicClient {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        Self { transport, fill_unsupported: Arc::default() }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.transport.request(method, params).await
    }

    pub async fn get_chain_id(&self) -> Result<u64, RpcError> {
        parse_u64(&self.request("eth_chainId", json!([])).await?, "chain id")
    }

    pub async fn get_block_number(&self) -> Result<u64, RpcError> {
        parse_u64(&self.request("eth_blockNumber", json!([])).await?, "block number")
    }

    /// The latest block, or the block at `number`.
    pub async fn get_block(&self, number: Option<u64>) -> Result<Block, RpcError> {
        let tag = number.map_or_else(|| "latest".to_string(), quantity);
        parse_block(&self.request("eth_getBlockByNumber", json!([tag, false])).await?)
    }

    /// `eth_call` at the latest block; an empty result is `None`.
    pub async fn call(&self, request: &CallRequest) -> Result<Option<Bytes>, RpcError> {
        self.call_at(request, "latest").await
    }

    pub async fn call_at(&self, request: &CallRequest, block: &str) -> Result<Option<Bytes>, RpcError> {
        let result = self.request("eth_call", json!([request.to_json(), block])).await?;
        let data = parse_hex(&result, "call result")?;
        Ok((!data.is_empty()).then_some(data))
    }

    /// `readContract`: encodes the call, decodes the result and classifies reverts.
    pub async fn read_contract<C: SolCall>(&self, address: Address, call: &C) -> anyhow::Result<C::Return> {
        let request = CallRequest { to: Some(address), data: call.abi_encode().into(), ..CallRequest::default() };
        let data = self.call(&request).await.map_err(|error| contract_error(C::SIGNATURE, error))?;
        let Some(data) = data else {
            anyhow::bail!("The contract function \"{}\" returned no data (\"0x\")", C::SIGNATURE);
        };
        Ok(C::abi_decode_returns(&data)?)
    }

    /// `simulateContract`: an `eth_call` from `account` that must not revert.
    pub async fn simulate_contract<C: SolCall>(
        &self,
        account: Address,
        address: Address,
        call: &C,
    ) -> anyhow::Result<C::Return> {
        let request = CallRequest {
            from: Some(account),
            to: Some(address),
            data: call.abi_encode().into(),
            ..CallRequest::default()
        };
        let data = self.call(&request).await.map_err(|error| contract_error(C::SIGNATURE, error))?.unwrap_or_default();
        Ok(C::abi_decode_returns(&data)?)
    }

    pub async fn estimate_gas(&self, request: &CallRequest) -> Result<u64, RpcError> {
        parse_u64(&self.request("eth_estimateGas", json!([request.to_json()])).await?, "gas")
    }

    pub async fn get_logs(&self, address: Address, from_block: u64, to_block: u64) -> Result<Vec<RpcLog>, RpcError> {
        let filter = json!({
            "address": address.to_checksum(None),
            "fromBlock": quantity(from_block),
            "toBlock": quantity(to_block),
        });
        let result = self.request("eth_getLogs", json!([filter])).await?;
        result
            .as_array()
            .ok_or_else(|| RpcError::InvalidResponse("logs are not an array".into()))?
            .iter()
            .map(parse_log)
            .collect()
    }

    /// `None` when the node does not know the transaction (`TransactionReceiptNotFoundError`).
    pub async fn get_transaction_receipt(&self, hash: &str) -> Result<Option<Receipt>, RpcError> {
        let receipt = self.request("eth_getTransactionReceipt", json!([hash])).await?;
        if receipt.is_null() {
            return Ok(None);
        }
        Ok(Some(Receipt {
            success: receipt["status"].as_str() == Some("0x1"),
            block_number: parse_u64(&receipt["blockNumber"], "receipt blockNumber")?,
        }))
    }

    pub async fn send_raw_transaction(&self, raw: &str) -> Result<String, RpcError> {
        parse_string(&self.request("eth_sendRawTransaction", json!([raw])).await?, "transaction hash")
    }

    pub async fn get_transaction_count(&self, address: Address) -> Result<u64, RpcError> {
        let params = json!([address.to_checksum(None), "pending"]);
        parse_u64(&self.request("eth_getTransactionCount", params).await?, "nonce")
    }

    /// `eth_fillTransaction`, or `None` when the node cannot fill. Unknown-method
    /// rejections are remembered so later preparations skip straight to the
    /// individual calls; other failures fall back once without being cached.
    /// Reverts are returned, as viem rethrows them.
    pub async fn fill_transaction(&self, request: &CallRequest) -> Result<Option<Value>, RpcError> {
        if self.fill_unsupported.load(Ordering::Relaxed) {
            return Ok(None);
        }
        match self.request("eth_fillTransaction", json!([request.to_json()])).await {
            Ok(response) => Ok(Some(response["tx"].clone())),
            Err(error) if error.is_execution_reverted() => Err(error),
            Err(error) => {
                if error.is_unsupported_method("eth_fillTransaction") {
                    self.fill_unsupported.store(true, Ordering::Relaxed);
                }
                Ok(None)
            }
        }
    }

    pub async fn get_gas_price(&self) -> Result<u128, RpcError> {
        parse_u128(&self.request("eth_gasPrice", json!([])).await?, "gas price")
    }

    pub async fn max_priority_fee_per_gas(&self) -> Result<u128, RpcError> {
        parse_u128(&self.request("eth_maxPriorityFeePerGas", json!([])).await?, "max priority fee")
    }

    pub async fn get_code(&self, address: Address) -> Result<Bytes, RpcError> {
        parse_hex(&self.request("eth_getCode", json!([address.to_checksum(None), "latest"])).await?, "code")
    }

    /// viem `verifyHash`: ERC-8010 wrapped signatures are checked by simulating the
    /// delegated account, everything else by universal ERC-6492/1271 validation through
    /// a deployless `eth_call`. Both fall back to ECDSA recovery.
    pub async fn verify_hash(&self, address: Address, hash: B256, signature: &Bytes) -> anyhow::Result<bool> {
        let outcome = if erc8010::is_wrapped(signature) {
            // RPC failures here are errors, as in viem; only failed checks are `false`.
            match erc8010::unwrap(signature) {
                Some(wrapped) => self.verify_erc8010(address, hash, &wrapped).await,
                None => Ok(false),
            }
        } else {
            self.verify_erc6492(address, hash, signature).await
        };
        if let Ok(true) = outcome {
            return Ok(true);
        }
        if recover_address(hash, signature) == Some(address) {
            return Ok(true);
        }
        outcome
    }

    async fn verify_erc6492(&self, address: Address, hash: B256, signature: &Bytes) -> anyhow::Result<bool> {
        let mut data = decode_bytecode(ERC6492_VALIDATOR_BYTECODE);
        data.extend((address, hash, signature.clone()).abi_encode_params());
        let request = CallRequest { data: data.into(), ..CallRequest::default() };
        // Any call failure is a verification failure (viem wraps it as `CallExecutionError`).
        match self.call(&request).await {
            Ok(result) => decode_validator_result(result.as_ref().map(|data| data.as_ref())),
            Err(_) => Ok(false),
        }
    }

    async fn verify_erc8010(&self, address: Address, hash: B256, wrapped: &Wrapped) -> anyhow::Result<bool> {
        let delegated = [&[0xef, 0x01, 0x00][..], wrapped.authorization.delegation.as_slice()].concat();
        if self.get_code(address).await?.as_ref() == delegated.as_slice() {
            return Ok(self.verify_erc1271(address, hash, &wrapped.signature).await);
        }
        if wrapped.authorization.authority() != Some(address) {
            return Ok(false);
        }
        // Deployless Multicall3 (`toDeploylessCallViaBytecodeData`) with the authorization applied.
        let mut data = decode_bytecode(DEPLOYLESS_CALL_BYTECODE);
        let calls = erc8010::verification_calls(address, hash, wrapped);
        data.extend((Bytes::from(decode_bytecode(MULTICALL3_BYTECODE)), calls).abi_encode_params());
        let request = CallRequest {
            data: data.into(),
            authorization_list: vec![wrapped.authorization.clone()],
            ..CallRequest::default()
        };
        let results = self.call_at(&request, "pending").await?.unwrap_or_default();
        erc8010::verification_succeeded(&results)
    }

    /// viem `verifyErc1271`: any failed or unexpected answer means "not valid".
    async fn verify_erc1271(&self, address: Address, hash: B256, signature: &Bytes) -> bool {
        let call = erc8010::isValidSignatureCall { hash, signature: signature.clone() };
        let request = CallRequest { to: Some(address), data: call.abi_encode().into(), ..CallRequest::default() };
        match self.call(&request).await {
            Ok(Some(result)) => result.len() >= 32 && result.starts_with(&ERC1271_MAGIC),
            _ => false,
        }
    }
}

fn decode_bytecode(text: &str) -> Vec<u8> {
    hex::decode(text.trim().trim_start_matches("0x")).expect("vendored bytecode is hex")
}

/// `hexToBool(data ?? "0x0")`: zero is false, one is true, anything else is an error.
fn decode_validator_result(data: Option<&[u8]>) -> anyhow::Result<bool> {
    let Some(data) = data else { return Ok(false) };
    let value = U256::try_from_be_slice(data);
    match value {
        Some(value) if value.is_zero() => Ok(false),
        Some(value) if value == U256::from(1) => Ok(true),
        _ => anyhow::bail!("Hex value \"0x{}\" is not a valid boolean", hex::encode(data)),
    }
}

/// viem `recoverAddress`: 65-byte `r || s || v` signatures with v in {0, 1, 27, 28}.
pub fn recover_address(hash: B256, signature: &[u8]) -> Option<Address> {
    if signature.len() != 65 {
        return None;
    }
    let parity = match signature[64] {
        0 | 27 => false,
        1 | 28 => true,
        _ => return None,
    };
    let r = U256::from_be_slice(&signature[..32]);
    let s = U256::from_be_slice(&signature[32..64]);
    Signature::new(r, s, parity).recover_address_from_prehash(&hash).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(code: i64, message: &str, data: Option<Value>) -> RpcError {
        RpcError::Node { code, message: message.into(), data }
    }

    #[test]
    fn classifies_reverts_like_viem() {
        assert!(node(3, "execution reverted", Some(json!("0x1234"))).is_contract_revert());
        assert!(node(-32603, "internal error", None).is_contract_revert());
        assert!(node(-32000, "execution reverted", Some(json!("0x12"))).is_contract_revert());
        assert!(!node(-32000, "execution reverted", None).is_contract_revert());
        assert!(!node(-32000, "nonce too low", Some(json!("0x12"))).is_contract_revert());
        assert!(!RpcError::Http("timeout".into()).is_contract_revert());
    }

    #[test]
    fn fallback_throws_only_for_deterministic_errors() {
        assert!(node(3, "execution reverted: InvalidReveal", None).should_throw());
        assert!(node(-32003, "transaction rejected", None).should_throw());
        assert!(node(-32000, "gas required exceeds allowance (0)", None).should_throw());
        assert!(!node(-32005, "limit exceeded", None).should_throw());
        assert!(!RpcError::Http("HTTP status 502".into()).should_throw());
    }

    #[test]
    fn validator_results_follow_hex_to_bool() {
        assert!(!decode_validator_result(None).unwrap());
        assert!(decode_validator_result(Some(&[1])).unwrap());
        assert!(decode_validator_result(Some(&B256::with_last_byte(1).0)).unwrap());
        assert!(!decode_validator_result(Some(&[0])).unwrap());
        assert!(decode_validator_result(Some(&[2])).is_err());
    }

    /// Answers every request with `result`.
    struct Answer(Value);

    impl Transport for Answer {
        fn request(&self, _method: &str, _params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
            let result = self.0.clone();
            Box::pin(async move { Ok(result) })
        }
    }

    fn answering(result: Value) -> PublicClient {
        PublicClient::new(Arc::new(Answer(result)))
    }

    #[tokio::test]
    async fn reports_missing_blocks_and_empty_contract_results() {
        let error = answering(Value::Null).get_block(Some(9)).await.unwrap_err();
        assert_eq!(error.to_string(), RpcError::InvalidResponse("Block could not be found".into()).to_string());
        let call = timba_protocol::evm::abi::creationNoncesCall { creator: Address::ZERO };
        let error = answering(json!("0x")).read_contract(Address::ZERO, &call).await.unwrap_err();
        assert_eq!(error.to_string(), "The contract function \"creationNonces(address)\" returned no data (\"0x\")");
    }

    #[test]
    fn formats_quantities_without_padding() {
        assert_eq!(quantity(0u64), "0x0");
        assert_eq!(quantity(499u64), "0x1f3");
    }

    mod erc8010_verification {
        use std::sync::Mutex;

        use alloy_signer_local::PrivateKeySigner;

        use super::*;
        use crate::erc8010::{testing::wrap, unwrap};

        fn fixture() -> Value {
            serde_json::from_str(include_str!("../tests/fixtures/erc8010.json")).unwrap()
        }

        fn hex(value: &Value) -> Bytes {
            value.as_str().unwrap().parse().unwrap()
        }

        type Answer = Box<dyn Fn(&str) -> Result<Value, RpcError> + Send + Sync>;

        struct Scripted {
            answer: Answer,
            calls: Mutex<Vec<Value>>,
        }

        impl Transport for Arc<Scripted> {
            fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
                self.calls.lock().unwrap().push(json!({ "method": method, "params": params }));
                let result = (self.answer)(method);
                Box::pin(async move { result })
            }
        }

        fn node_with(
            code: &str,
            call: impl Fn() -> Result<Value, RpcError> + Send + Sync + 'static,
        ) -> (PublicClient, Arc<Scripted>) {
            let code = json!(code);
            let scripted = Arc::new(Scripted {
                answer: Box::new(move |method| match method {
                    "eth_getCode" => Ok(code.clone()),
                    "eth_call" => call(),
                    _ => unreachable!("{method}"),
                }),
                calls: Mutex::new(Vec::new()),
            });
            (PublicClient::new(Arc::new(scripted.clone())), scripted)
        }

        fn account() -> PrivateKeySigner {
            fixture()["key"].as_str().unwrap().parse().unwrap()
        }

        fn hash() -> B256 {
            fixture()["hash"].as_str().unwrap().parse().unwrap()
        }

        fn delegation() -> Address {
            fixture()["delegation"].as_str().unwrap().parse().unwrap()
        }

        /// Addresses are checksummed here and lowercase in the fixture; nodes ignore case.
        fn lowercase(requests: &[Value]) -> Value {
            serde_json::from_str(&Value::Array(requests.to_vec()).to_string().to_lowercase()).unwrap()
        }

        #[test]
        fn wraps_and_unwraps_like_ox() {
            let fixture = fixture();
            let inner = hex(&fixture["inner"]);
            let init = (Address::repeat_byte(0x44), Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]));
            assert_eq!(wrap(&account(), delegation(), &inner, Some(init.clone())), hex(&fixture["withInit"]));
            assert_eq!(wrap(&account(), delegation(), &inner, None), hex(&fixture["plain"]));

            let wrapped = unwrap(&hex(&fixture["withInit"])).unwrap();
            assert_eq!((wrapped.signature, wrapped.init), (inner.clone(), Some(init)));
            assert_eq!(wrapped.authorization.authority(), Some(account().address()));
            let plain = unwrap(&hex(&fixture["plain"])).unwrap();
            assert_eq!((plain.signature, plain.init), (inner, None));
        }

        #[tokio::test]
        async fn matches_viem_requests_and_verdicts() {
            let fixture = fixture();
            let answers = fixture["answers"].clone();
            let cases = [
                ("deployless", "withInit", "0x".to_string(), answers["ok"].clone()),
                ("rejected", "plain", "0x".to_string(), answers["bad"].clone()),
                (
                    "delegated",
                    "plain",
                    format!("0xef0100{}", hex::encode(delegation())),
                    json!(format!("0x1626ba7e{}", "00".repeat(28))),
                ),
            ];
            for (case, signature, code, answer) in cases {
                let (client, scripted) = node_with(&code, move || Ok(answer.clone()));
                let valid = client.verify_hash(account().address(), hash(), &hex(&fixture[signature])).await.unwrap();
                assert_eq!(json!(valid), fixture[case]["valid"], "{case}");
                let expected = fixture[case]["requests"].as_array().unwrap();
                assert!(lowercase(&scripted.calls.lock().unwrap()) == lowercase(expected), "{case} requests differ");
            }
        }

        #[tokio::test]
        async fn failed_simulations_and_code_lookups_are_errors() {
            let fixture = fixture();
            assert_eq!(fixture["callFails"]["valid"], "error");
            let plain = hex(&fixture["plain"]);
            let (client, _) =
                node_with("0x", || Err(RpcError::Node { code: -32000, message: "boom".into(), data: None }));
            assert!(client.verify_hash(account().address(), hash(), &plain).await.is_err());
            let (client, _) = node_with("0x", || Ok(json!("0x1234")));
            assert!(client.verify_hash(account().address(), hash(), &plain).await.is_err());

            let failing = Arc::new(Scripted {
                answer: Box::new(|_| Err(RpcError::Http("down".into()))),
                calls: Mutex::default(),
            });
            let client = PublicClient::new(Arc::new(failing));
            assert!(client.verify_hash(account().address(), hash(), &plain).await.is_err());
        }

        #[tokio::test]
        async fn rejects_without_simulating_when_the_authorization_is_not_the_signers() {
            let plain = hex(&fixture()["plain"]);
            let (client, scripted) = node_with("0x", || unreachable!("no simulation"));
            assert!(!client.verify_hash(Address::repeat_byte(9), hash(), &plain).await.unwrap());
            assert_eq!(scripted.calls.lock().unwrap().len(), 1);

            // An already delegated account whose ERC-1271 check fails or reverts.
            let code = format!("0xef0100{}", hex::encode(delegation()));
            for answer in [Ok(json!("0xffffffff")), Ok(json!("0x1626ba7e")), Err(RpcError::Http("revert".into()))] {
                let (client, _) = node_with(&code, move || answer.clone());
                assert!(!client.verify_hash(account().address(), hash(), &plain).await.unwrap());
            }
        }

        #[tokio::test]
        async fn malformed_wrappers_are_invalid_without_any_request() {
            let plain = hex(&fixture()["plain"]).to_vec();
            let magic = &plain[plain.len() - 32..];
            let mut huge_length = plain.clone();
            let at = huge_length.len() - 64;
            huge_length[at..at + 32].copy_from_slice(&[0xff; 32]);
            let mut too_long = plain.clone();
            too_long[at + 31] = 0xf0;
            let mut garbage = vec![0u8; 32];
            garbage.extend(U256::from(32).to_be_bytes::<32>());
            garbage.extend(magic);
            let mut bad_parity = plain.clone();
            bad_parity[65 + 3 * 32 + 31] = 2;
            let mut huge_nonce = plain.clone();
            huge_nonce[65 + 2 * 32] = 1;
            for signature in [magic.to_vec(), huge_length, too_long, garbage, huge_nonce] {
                let (client, scripted) = node_with("0x", || unreachable!());
                assert!(!client.verify_hash(account().address(), hash(), &signature.into()).await.unwrap());
                assert!(scripted.calls.lock().unwrap().is_empty());
            }
            assert_eq!(unwrap(&bad_parity).unwrap().authorization.authority(), None);
            // Both valid parities recover some authority; only one recovers the signer.
            let authorization = unwrap(&plain).unwrap().authorization;
            for y_parity in [0, 1] {
                let recovered = SignedAuthorization { y_parity, ..authorization.clone() }.authority();
                assert!(recovered.is_some(), "parity {y_parity}");
                assert_eq!(recovered == Some(account().address()), y_parity == authorization.y_parity);
            }
        }
    }
}
