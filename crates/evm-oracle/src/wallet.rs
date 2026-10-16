//! The operator's local account: EIP-712 signatures and settlement transactions
//! (viem `privateKeyToAccount` plus the wallet client's preparation rules).

use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope, TxLegacy};
use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{Address, Bytes, TxKind, B256, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;

use serde_json::Value;

use crate::rpc::{parse_u128, parse_u64, CallRequest, PublicClient, RpcError};

/// Fee fields chosen during preparation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fees {
    Eip1559 { max_fee_per_gas: u128, max_priority_fee_per_gas: u128 },
    Legacy { gas_price: u128 },
}

/// A fully specified transaction ready for local signing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTransaction {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: Address,
    pub data: Bytes,
    pub gas: u64,
    pub fees: Fees,
}

impl PreparedTransaction {
    /// The prepared fields as a call request, for gas estimation.
    pub fn call_request(&self, from: Address) -> CallRequest {
        let mut request = CallRequest {
            from: Some(from),
            to: Some(self.to),
            data: self.data.clone(),
            nonce: Some(self.nonce),
            ..CallRequest::default()
        };
        match self.fees {
            Fees::Eip1559 { max_fee_per_gas, max_priority_fee_per_gas } => {
                request.max_fee_per_gas = Some(max_fee_per_gas);
                request.max_priority_fee_per_gas = Some(max_priority_fee_per_gas);
                request.eip1559 = Some(true);
            }
            Fees::Legacy { gas_price } => {
                request.gas_price = Some(gas_price);
                request.eip1559 = Some(false);
            }
        }
        request
    }
}

/// viem's default `baseFeeMultiplier` of 1.2.
fn with_base_fee_margin(base: u128) -> u128 {
    base.saturating_mul(12) / 10
}

/// viem fee estimation: EIP-1559 when the latest block has a base fee, legacy otherwise.
pub async fn estimate_fees(client: &PublicClient) -> anyhow::Result<Fees> {
    let block = client.get_block(None).await?;
    let Some(base_fee) = block.base_fee_per_gas else {
        let gas_price = client.get_gas_price().await?;
        return Ok(Fees::Legacy { gas_price: with_base_fee_margin(gas_price) });
    };
    let max_priority_fee_per_gas = match client.max_priority_fee_per_gas().await {
        Ok(fee) => fee,
        // Providers without `eth_maxPriorityFeePerGas`: gasPrice - baseFee, floored at zero.
        Err(_) => client.get_gas_price().await?.saturating_sub(base_fee),
    };
    Ok(Fees::Eip1559 {
        max_fee_per_gas: with_base_fee_margin(base_fee) + max_priority_fee_per_gas,
        max_priority_fee_per_gas,
    })
}

/// What `eth_fillTransaction` chose. Missing fields are filled the usual way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Filled {
    pub nonce: Option<u64>,
    pub gas: Option<u64>,
    pub fees: Option<Fees>,
}

/// viem's `fillTransaction`: the node's nonce, gas and fees, with the node's fee
/// cap (or gas price) raised by the 1.2 base fee multiplier. `Ok(None)` means
/// the node cannot fill (or answered with an unreadable transaction), so every
/// field is prepared individually. Reverts are errors.
pub async fn fill_transaction(client: &PublicClient, request: &CallRequest) -> Result<Option<Filled>, RpcError> {
    Ok(client.fill_transaction(request).await?.and_then(|tx| parse_filled(&tx).ok()))
}

fn parse_filled(tx: &Value) -> Result<Filled, RpcError> {
    let field = |name: &str| tx.get(name).filter(|value| !value.is_null());
    let fee = |name: &str| field(name).map(|value| parse_u128(value, name)).transpose();
    let (max_fee, priority, gas_price) = (fee("maxFeePerGas")?, fee("maxPriorityFeePerGas")?, fee("gasPrice")?);
    let legacy = match field("type").and_then(Value::as_str) {
        Some(kind) => matches!(kind, "0x0" | "0x1"),
        None => max_fee.is_none(),
    };
    let fees = match (legacy, max_fee, priority, gas_price) {
        (false, Some(max_fee), Some(priority), _) => {
            Some(Fees::Eip1559 { max_fee_per_gas: with_base_fee_margin(max_fee), max_priority_fee_per_gas: priority })
        }
        (true, _, _, Some(gas_price)) => Some(Fees::Legacy { gas_price: with_base_fee_margin(gas_price) }),
        _ => None,
    };
    Ok(Filled {
        nonce: field("nonce").map(|value| parse_u64(value, "nonce")).transpose()?,
        gas: field("gas").map(|value| parse_u64(value, "gas")).transpose()?,
        fees,
    })
}

pub struct OperatorWallet {
    signer: PrivateKeySigner,
}

impl OperatorWallet {
    /// `key` is a 32-byte private key.
    pub fn new(key: B256) -> anyhow::Result<Self> {
        Ok(Self { signer: PrivateKeySigner::from_bytes(&key)? })
    }

    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Signs a digest as `r || s || v` with v in {27, 28}, like viem's `signTypedData`.
    pub fn sign_hash(&self, hash: B256) -> anyhow::Result<Bytes> {
        let signature = self.signer.sign_hash_sync(&hash)?;
        Ok(Bytes::copy_from_slice(&signature.as_bytes()))
    }

    /// Serializes and signs the transaction (EIP-1559 type 2, or EIP-155 legacy).
    pub fn sign_transaction(&self, transaction: &PreparedTransaction) -> anyhow::Result<Bytes> {
        let envelope: TxEnvelope = match transaction.fees {
            Fees::Eip1559 { max_fee_per_gas, max_priority_fee_per_gas } => {
                let tx = TxEip1559 {
                    chain_id: transaction.chain_id,
                    nonce: transaction.nonce,
                    gas_limit: transaction.gas,
                    max_fee_per_gas,
                    max_priority_fee_per_gas,
                    to: TxKind::Call(transaction.to),
                    value: U256::ZERO,
                    access_list: Default::default(),
                    input: transaction.data.clone(),
                };
                let signature = self.signer.sign_hash_sync(&tx.signature_hash())?;
                tx.into_signed(signature).into()
            }
            Fees::Legacy { gas_price } => {
                let tx = TxLegacy {
                    chain_id: Some(transaction.chain_id),
                    nonce: transaction.nonce,
                    gas_price,
                    gas_limit: transaction.gas,
                    to: TxKind::Call(transaction.to),
                    value: U256::ZERO,
                    input: transaction.data.clone(),
                };
                let signature = self.signer.sign_hash_sync(&tx.signature_hash())?;
                tx.into_signed(signature).into()
            }
        };
        Ok(envelope.encoded_2718().into())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::future::BoxFuture;
    use serde_json::json;

    use super::*;
    use crate::rpc::Transport;

    type Answer = Box<dyn Fn() -> Result<Value, RpcError> + Send + Sync>;

    /// Answers every `eth_fillTransaction` with `answer` and counts the requests.
    struct Filler {
        answer: Answer,
        calls: Mutex<Vec<Value>>,
    }

    impl Transport for Arc<Filler> {
        fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Result<Value, RpcError>> {
            assert_eq!(method, "eth_fillTransaction");
            self.calls.lock().unwrap().push(params);
            let result = (self.answer)();
            Box::pin(async move { result })
        }
    }

    fn client(answer: impl Fn() -> Result<Value, RpcError> + Send + Sync + 'static) -> (PublicClient, Arc<Filler>) {
        let filler = Arc::new(Filler { answer: Box::new(answer), calls: Mutex::new(Vec::new()) });
        (PublicClient::new(Arc::new(filler.clone())), filler)
    }

    fn request() -> CallRequest {
        CallRequest { from: Some(Address::repeat_byte(1)), to: Some(Address::repeat_byte(2)), ..CallRequest::default() }
    }

    fn node(code: i64, message: &str) -> RpcError {
        RpcError::Node { code, message: message.into(), data: None }
    }

    #[tokio::test]
    async fn raises_the_node_fee_cap_by_the_base_fee_multiplier() {
        // geth fills maxFeePerGas = 2 x base fee + tip; viem signs 1.2 x that.
        let (client, filler) = client(|| {
            Ok(json!({ "raw": "0x", "tx": {
                "type": "0x2", "nonce": "0x9", "gas": "0x5208",
                "maxFeePerGas": "0xb2d05e00", "maxPriorityFeePerGas": "0x3b9aca00", "gasPrice": "0xb2d05e00"
            }}))
        });
        let filled = fill_transaction(&client, &request()).await.unwrap().unwrap();
        assert_eq!(
            filled,
            Filled {
                nonce: Some(9),
                gas: Some(21_000),
                fees: Some(Fees::Eip1559 { max_fee_per_gas: 3_600_000_000, max_priority_fee_per_gas: 1_000_000_000 }),
            }
        );
        let sent = &filler.calls.lock().unwrap()[0][0];
        assert_eq!(sent["from"], Address::repeat_byte(1).to_checksum(None));
        assert!(sent.get("nonce").is_none() && sent.get("gas").is_none() && sent.get("maxFeePerGas").is_none());
    }

    #[test]
    fn reads_legacy_and_partial_fills() {
        let legacy = parse_filled(&json!({ "type": "0x0", "gasPrice": "0x64", "maxFeePerGas": "0x1" })).unwrap();
        assert_eq!(legacy.fees, Some(Fees::Legacy { gas_price: 120 }));
        let untyped = parse_filled(&json!({ "gasPrice": "0x64" })).unwrap();
        assert_eq!(untyped.fees, Some(Fees::Legacy { gas_price: 120 }));
        let untyped_1559 = parse_filled(&json!({ "maxFeePerGas": "0x64", "maxPriorityFeePerGas": "0x1" })).unwrap();
        assert_eq!(untyped_1559.fees, Some(Fees::Eip1559 { max_fee_per_gas: 120, max_priority_fee_per_gas: 1 }));
        // A fee cap without a tip, or no fees at all, leaves fee estimation to the caller.
        assert_eq!(parse_filled(&json!({ "type": "0x2", "maxFeePerGas": "0x64" })).unwrap().fees, None);
        assert_eq!(parse_filled(&json!({ "type": "0x0", "nonce": null })).unwrap(), Filled::default());
        assert!(parse_filled(&json!({ "gas": "12" })).is_err());
        assert!(parse_filled(&json!({ "maxFeePerGas": 5 })).is_err());
    }

    #[tokio::test]
    async fn falls_back_on_unreadable_fills() {
        let (client, filler) = client(|| Ok(json!({ "tx": { "nonce": "nope" } })));
        assert_eq!(fill_transaction(&client, &request()).await.unwrap(), None);
        assert_eq!(fill_transaction(&client, &request()).await.unwrap(), None);
        assert_eq!(filler.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn remembers_nodes_without_the_method() {
        for error in [
            node(-32601, "method not found"),
            node(-32004, "method not supported"),
            node(-32000, "eth_fillTransaction is not available on this endpoint"),
        ] {
            let (client, filler) = client(move || Err(error.clone()));
            assert_eq!(fill_transaction(&client, &request()).await.unwrap(), None);
            assert_eq!(fill_transaction(&client.clone(), &request()).await.unwrap(), None);
            assert_eq!(filler.calls.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn retries_the_fill_after_other_failures() {
        for error in [RpcError::Http("HTTP status 502".into()), node(-32005, "limit exceeded")] {
            let (client, filler) = client(move || Err(error.clone()));
            assert_eq!(fill_transaction(&client, &request()).await.unwrap(), None);
            assert_eq!(fill_transaction(&client, &request()).await.unwrap(), None);
            assert_eq!(filler.calls.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn surfaces_reverts() {
        for error in [
            node(3, "execution reverted: GameNotSettleable"),
            node(-32000, "Execution Reverted"),
            node(-32000, "gas required exceeds allowance (0)"),
        ] {
            let (client, filler) = client(move || Err(error.clone()));
            assert!(fill_transaction(&client, &request()).await.is_err());
            assert!(fill_transaction(&client, &request()).await.is_err());
            assert_eq!(filler.calls.lock().unwrap().len(), 2);
        }
    }
}
