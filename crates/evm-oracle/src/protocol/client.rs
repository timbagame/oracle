//! Typed data, identifiers and transactions for EVM contract v0.1.0
//! (`evm/v0.1.0/client.ts` and `randomness.ts`).

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, Eip712Domain, SolCall, SolStruct, SolValue};
use sha2::{Digest, Sha256};

use super::abi::{completeGameCall, CreateRequest};
use super::schema::MAX_SAFE_INTEGER;

/// Interface selection is explicit; a proxy address does not prove its current version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmDeployment {
    pub chain_id: u64,
    pub address: Address,
    pub version: String,
}

pub const EVM_CONTRACT_VERSION: &str = "0.1.0";

sol! {
    /// EIP-712 creation authorization, signed by the creator (zero commitment) and the Oracle.
    struct CreateGame {
        address creator;
        address token;
        uint8 gameType;
        uint256 amount;
        uint32 minPlayers;
        uint32 maxPlayers;
        uint32 timeout;
        bool isPrivate;
        bytes32 commitment;
        uint256 nonce;
        uint256 deadline;
    }

    /// EIP-712 private-game invitation for one player and deadline.
    struct JoinGame {
        bytes32 gameId;
        address player;
        uint256 deadline;
    }
}

pub fn evm_domain(deployment: &EvmDeployment) -> anyhow::Result<Eip712Domain> {
    if deployment.version != EVM_CONTRACT_VERSION {
        anyhow::bail!("Unsupported EVM contract version");
    }
    if deployment.chain_id == 0 || deployment.chain_id > MAX_SAFE_INTEGER as u64 {
        anyhow::bail!("Invalid EVM chain ID");
    }
    Ok(Eip712Domain {
        name: Some("Timba".into()),
        version: Some("1".into()),
        chain_id: Some(U256::from(deployment.chain_id)),
        verifying_contract: Some(deployment.address),
        salt: None,
    })
}

fn creation_struct(request: &CreateRequest) -> CreateGame {
    CreateGame {
        creator: request.creator,
        token: request.token,
        gameType: request.gameType,
        amount: request.amount,
        minPlayers: request.minPlayers,
        maxPlayers: request.maxPlayers,
        timeout: request.timeout,
        isPrivate: request.isPrivate,
        commitment: request.commitment,
        nonce: request.nonce,
        deadline: request.deadline,
    }
}

/// EIP-712 digest of `creationTypedData(deployment, request)`.
pub fn creation_digest(deployment: &EvmDeployment, request: &CreateRequest) -> anyhow::Result<B256> {
    Ok(creation_struct(request).eip712_signing_hash(&evm_domain(deployment)?))
}

/// EIP-712 digest of `privateJoinTypedData(deployment, gameId, player, deadline)`.
pub fn private_join_digest(
    deployment: &EvmDeployment,
    game_id: B256,
    player: Address,
    deadline: U256,
) -> anyhow::Result<B256> {
    let message = JoinGame { gameId: game_id, player, deadline };
    Ok(message.eip712_signing_hash(&evm_domain(deployment)?))
}

/// `keccak256(abi.encode(chainId, proxy, creator, nonce))`, matching the contract's `gameIdFor`.
pub fn game_id_for(deployment: &EvmDeployment, creator: Address, nonce: U256) -> anyhow::Result<B256> {
    evm_domain(deployment)?;
    let encoded = (U256::from(deployment.chain_id), deployment.address, creator, nonce).abi_encode();
    Ok(keccak256(encoded))
}

/// Unsigned call to the configured proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractTransaction {
    pub chain_id: u64,
    pub to: Address,
    pub data: Bytes,
    pub value: U256,
}

pub fn complete_game_transaction(
    deployment: &EvmDeployment,
    game_id: B256,
    secret: B256,
) -> anyhow::Result<ContractTransaction> {
    evm_domain(deployment)?;
    let call = completeGameCall { gameId: game_id, secret };
    Ok(ContractTransaction {
        chain_id: deployment.chain_id,
        to: deployment.address,
        data: call.abi_encode().into(),
        value: U256::ZERO,
    })
}

/// `sha256(secret)`, the commitment revealed by `completeGame`.
pub fn commitment_for(secret: B256) -> B256 {
    B256::from_slice(&Sha256::digest(secret.as_slice()))
}
