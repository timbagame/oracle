//! Minimal EVM JSON-RPC client with the semantics the TypeScript service got from viem:
//! an ordered HTTP fallback transport (3 s per endpoint, no retries, no ranking),
//! typed contract reads, revert classification and ERC-6492 signature verification.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, Bytes, Signature, B256, U256};
use alloy_sol_types::{SolCall, SolValue};
use futures::future::BoxFuture;
use serde_json::{json, Value};

use crate::protocol::abi::ERC6492_VALIDATOR_BYTECODE;

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
        let client =
            reqwest::Client::builder().timeout(RPC_TIMEOUT).build().expect("HTTP client configuration is valid");
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
            let last = transports.len() - 1;
            for (index, transport) in transports.iter().enumerate() {
                match transport.request(&method, params.clone()).await {
                    Ok(result) => return Ok(result),
                    Err(error) if error.should_throw() || index == last => return Err(error),
                    Err(_) => continue,
                }
            }
            unreachable!("the last transport always returns")
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
}

impl CallRequest {
    fn to_json(&self) -> Value {
        let mut request = serde_json::Map::new();
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

fn parse_u64(value: &Value, field: &str) -> Result<u64, RpcError> {
    let number = parse_quantity(value, field)?;
    u64::try_from(number).map_err(|_| RpcError::InvalidResponse(format!("{field} is too large")))
}

fn parse_u128(value: &Value, field: &str) -> Result<u128, RpcError> {
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
        .and_then(crate::protocol::schema::parse_address)
        .ok_or_else(|| RpcError::InvalidResponse("log address is invalid".into()))?;
    let topics = value["topics"]
        .as_array()
        .ok_or_else(|| RpcError::InvalidResponse("log topics are missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .and_then(crate::protocol::schema::parse_bytes32)
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
}

impl PublicClient {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        Self { transport }
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
        let result = self.request("eth_call", json!([request.to_json(), "latest"])).await?;
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

    pub async fn get_gas_price(&self) -> Result<u128, RpcError> {
        parse_u128(&self.request("eth_gasPrice", json!([])).await?, "gas price")
    }

    pub async fn max_priority_fee_per_gas(&self) -> Result<u128, RpcError> {
        parse_u128(&self.request("eth_maxPriorityFeePerGas", json!([])).await?, "max priority fee")
    }

    /// viem `verifyHash`: universal ERC-6492/1271 validation through a deployless `eth_call`,
    /// falling back to ECDSA recovery when the call fails or reports an invalid signature.
    pub async fn verify_hash(&self, address: Address, hash: B256, signature: &Bytes) -> anyhow::Result<bool> {
        let bytecode = hex::decode(ERC6492_VALIDATOR_BYTECODE.trim().trim_start_matches("0x"))
            .expect("vendored validator bytecode is hex");
        let mut data = bytecode;
        data.extend((address, hash, signature.clone()).abi_encode_params());
        let request = CallRequest { data: data.into(), ..CallRequest::default() };
        // Any call failure is a verification failure (viem wraps it as `CallExecutionError`).
        let outcome = match self.call(&request).await {
            Ok(result) => decode_validator_result(result.as_ref().map(|data| data.as_ref())),
            Err(_) => Ok(false),
        };
        if let Ok(true) = outcome {
            return Ok(true);
        }
        if recover_address(hash, signature) == Some(address) {
            return Ok(true);
        }
        outcome
    }
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

    #[test]
    fn formats_quantities_without_padding() {
        assert_eq!(quantity(0u64), "0x0");
        assert_eq!(quantity(499u64), "0x1f3");
    }
}
