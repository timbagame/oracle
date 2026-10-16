//! ERC-8010 wrapped signatures (ox `SignatureErc8010`): a signature from an
//! account that has not applied its EIP-7702 delegation yet, carrying the signed
//! authorization so verifiers can simulate the delegated account.
//! Layout: `signature || abi(suffix) || uint256(len(suffix)) || magic`.

use alloy_eips::eip7702::Authorization;
use alloy_primitives::{b256, Address, Bytes, B256, U256};
use alloy_sol_types::sol_data;
use alloy_sol_types::{SolCall, SolType};
use serde_json::{json, Value};

use crate::rpc::{quantity, recover_address};

/// `(authorization, to, data)` after the signature.
type Suffix = (AuthorizationTuple, sol_data::Address, sol_data::Bytes);

const MAGIC: B256 = b256!("8010801080108010801080108010801080108010801080108010801080108010");

alloy_sol_types::sol! {
    struct AuthorizationTuple { uint256 chainId; address delegation; uint256 nonce; uint8 yParity; uint256 r; uint256 s; }
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result3 { bool success; bytes returnData; }
    function aggregate3(Call3[] calls) returns (Result3[] returnData);
    function isValidSignature(bytes32 hash, bytes signature) returns (bytes4);
}

/// ERC-1271 `isValidSignature` magic value.
pub const ERC1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// The signed EIP-7702 authorization inside a wrapped signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedAuthorization {
    pub chain_id: U256,
    pub delegation: Address,
    pub nonce: u64,
    pub y_parity: u8,
    pub r: U256,
    pub s: U256,
}

impl SignedAuthorization {
    /// viem `verifyAuthorization`: the account that signed the authorization.
    pub fn authority(&self) -> Option<Address> {
        let hash =
            Authorization { chain_id: self.chain_id, address: self.delegation, nonce: self.nonce }.signature_hash();
        if self.y_parity > 1 {
            return None;
        }
        let mut signature = [0u8; 65];
        signature[..32].copy_from_slice(&self.r.to_be_bytes::<32>());
        signature[32..64].copy_from_slice(&self.s.to_be_bytes::<32>());
        signature[64] = self.y_parity;
        recover_address(hash, &signature)
    }

    /// `formatAuthorizationList` entry for an `eth_call`.
    pub fn to_rpc(&self) -> Value {
        json!({
            "address": self.delegation.to_string().to_lowercase(),
            "chainId": format!("{:#x}", self.chain_id),
            "nonce": quantity(self.nonce),
            "r": format!("{:#x}", self.r),
            "s": format!("{:#x}", self.s),
            "yParity": quantity(self.y_parity),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wrapped {
    pub authorization: SignedAuthorization,
    pub signature: Bytes,
    /// Optional account initialization call (`to`, `data`) run before verification.
    pub init: Option<(Address, Bytes)>,
}

/// ox `SignatureErc8010.validate`: the signature ends with the magic bytes.
pub fn is_wrapped(signature: &[u8]) -> bool {
    signature.len() >= 32 && signature[signature.len() - 32..] == MAGIC[..]
}

/// ox `SignatureErc8010.unwrap`, or `None` when the wrapper is malformed.
pub fn unwrap(wrapped: &[u8]) -> Option<Wrapped> {
    if !is_wrapped(wrapped) || wrapped.len() < 64 {
        return None;
    }
    let length_word = U256::from_be_slice(&wrapped[wrapped.len() - 64..wrapped.len() - 32]);
    let suffix_length = usize::try_from(length_word).ok()?;
    let signature_end = (wrapped.len() - 64).checked_sub(suffix_length)?;
    let suffix = &wrapped[signature_end..wrapped.len() - 64];
    let (auth, to, data) = Suffix::abi_decode_params(suffix).ok()?;
    Some(Wrapped {
        authorization: SignedAuthorization {
            chain_id: auth.chainId,
            delegation: auth.delegation,
            nonce: u64::try_from(auth.nonce).ok()?,
            y_parity: auth.yParity,
            r: auth.r,
            s: auth.s,
        },
        signature: Bytes::copy_from_slice(&wrapped[..signature_end]),
        init: (!data.is_empty()).then_some((to, data)),
    })
}

/// `aggregate3` calldata: the optional initialization, then `isValidSignature`.
pub fn verification_calls(address: Address, hash: B256, wrapped: &Wrapped) -> Bytes {
    let mut calls: Vec<Call3> = wrapped
        .init
        .iter()
        .map(|(to, data)| Call3 { target: *to, allowFailure: true, callData: data.clone() })
        .collect();
    calls.push(Call3 {
        target: address,
        allowFailure: true,
        callData: isValidSignatureCall { hash, signature: wrapped.signature.clone() }.abi_encode().into(),
    });
    aggregate3Call { calls }.abi_encode().into()
}

/// True when the last `aggregate3` result starts with the ERC-1271 magic value.
pub fn verification_succeeded(results: &[u8]) -> anyhow::Result<bool> {
    let results = aggregate3Call::abi_decode_returns(results)?;
    Ok(results.last().is_some_and(|result| result.returnData.starts_with(&ERC1271_MAGIC)))
}

#[cfg(test)]
pub mod testing {
    use alloy_signer::SignerSync;
    use alloy_signer_local::PrivateKeySigner;

    use super::*;

    /// ox `SignatureErc8010.wrap` with an authorization signed by `account`.
    pub fn wrap(
        account: &PrivateKeySigner,
        delegation: Address,
        signature: &[u8],
        init: Option<(Address, Bytes)>,
    ) -> Bytes {
        let authorization = Authorization { chain_id: U256::from(31337), address: delegation, nonce: 4 };
        let signed = account.sign_hash_sync(&authorization.signature_hash()).unwrap();
        let (to, data) = init.unwrap_or((account.address(), Bytes::new()));
        let tuple = AuthorizationTuple {
            chainId: U256::from(31337),
            delegation,
            nonce: U256::from(4),
            yParity: signed.v() as u8,
            r: signed.r(),
            s: signed.s(),
        };
        let suffix = Suffix::abi_encode_params(&(tuple, to, data));
        [signature, &suffix, &U256::from(suffix.len()).to_be_bytes::<32>(), MAGIC.as_slice()].concat().into()
    }
}
