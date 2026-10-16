//! The operator's local account: EIP-712 signatures and settlement transactions
//! (viem `privateKeyToAccount` plus the wallet client's preparation rules).

use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope, TxLegacy};
use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{Address, Bytes, TxKind, B256, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;

use crate::rpc::{CallRequest, PublicClient};

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
