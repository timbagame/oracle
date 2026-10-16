//! Solana network access: JSON-RPC with endpoint failover, log subscriptions,
//! keypairs and transaction confirmation.

pub mod confirm;
pub mod keypair;
pub mod pool;
pub mod rpc;
pub mod tx;
pub mod ws;

pub use keypair::Keypair;
pub use pool::RpcPool;
pub use rpc::{RpcError, RpcTransport};
