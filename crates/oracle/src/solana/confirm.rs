//! Transaction confirmation polling and expiry-aware submission (ports of
//! `confirmTransaction` and `TransactionSubmitter`).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use timba_common::warn;

use super::pool::RpcPool;
use super::rpc::LatestBlockhash;

pub const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Polls signature status until the transaction is confirmed, fails, expires
/// or times out.
pub async fn confirm_transaction(rpc: &RpcPool, signature: &str, latest: &LatestBlockhash) -> anyhow::Result<()> {
    let deadline = Instant::now() + CONFIRMATION_TIMEOUT;
    let signatures = [signature.to_string()];
    while Instant::now() < deadline {
        let (statuses, block_height) =
            tokio::try_join!(rpc.get_signature_statuses(&signatures), rpc.get_block_height())?;
        if let Some(Some(status)) = statuses.first() {
            if let Some(err) = &status.err {
                anyhow::bail!("Transaction {signature} failed: {}", serde_json::to_string(err).unwrap_or_default());
            }
            if status.is_confirmed() {
                return Ok(());
            }
        }
        if block_height > latest.last_valid_block_height {
            anyhow::bail!("Transaction {signature} expired before confirmation");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    anyhow::bail!("Transaction {signature} confirmation timed out")
}

fn expiry_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)blockhash not found|block height exceeded|transaction expired|expired before confirmation")
            .unwrap()
    })
}

pub fn should_retry_after_expiry(message: &str) -> bool {
    expiry_re().is_match(message)
}

/// Signs with a fresh blockhash, sends and confirms; retries once with a new
/// blockhash when the first attempt expired, unless the expired transaction
/// actually landed.
pub async fn submit_transaction<S>(
    rpc: &RpcPool,
    mut sign: S,
    on_retry: Option<&(dyn Fn(&anyhow::Error) + Sync)>,
) -> anyhow::Result<String>
where
    S: FnMut(&LatestBlockhash) -> anyhow::Result<String>,
{
    let mut last_signature: Option<String> = None;
    let latest = rpc.get_latest_blockhash().await?;
    let first = send_and_confirm(rpc, &mut sign, &latest, &mut last_signature).await;
    let error = match first {
        Ok(signature) => return Ok(signature),
        Err(error) => error,
    };
    if !should_retry_after_expiry(&format!("{error:#}")) {
        return Err(error);
    }
    if let Some(callback) = on_retry {
        callback(&error);
    }
    if let Some(signature) = &last_signature {
        match rpc.get_signature_statuses(std::slice::from_ref(signature)).await {
            Ok(statuses) => {
                if let Some(Some(status)) = statuses.first() {
                    if status.err.is_none() && status.is_confirmed() {
                        return Ok(signature.clone());
                    }
                }
            }
            Err(status_error) => warn!("⚠️ Failed to check status of expired tx {signature}: {status_error}"),
        }
    }
    let latest = rpc.get_latest_blockhash().await?;
    send_and_confirm(rpc, &mut sign, &latest, &mut last_signature).await
}

async fn send_and_confirm<S>(
    rpc: &RpcPool,
    sign: &mut S,
    latest: &LatestBlockhash,
    last_signature: &mut Option<String>,
) -> anyhow::Result<String>
where
    S: FnMut(&LatestBlockhash) -> anyhow::Result<String>,
{
    let wire = sign(latest)?;
    let signature = rpc.send_transaction(&wire).await?;
    *last_signature = Some(signature.clone());
    confirm_transaction(rpc, &signature, latest).await?;
    Ok(signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::rpc::RpcError;
    use serde_json::json;
    use std::sync::Arc;

    fn blockhash() -> serde_json::Value {
        json!({"value": {"blockhash": "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", "lastValidBlockHeight": 100}})
    }

    #[tokio::test]
    async fn confirms_and_reports_failures() {
        let transport = FakeTransport::new();
        transport.on(|_, m, _| (m == "getBlockHeight").then(|| Ok(json!(10))));
        transport.push(
            "getSignatureStatuses",
            Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})),
        );
        let pool = RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap();
        let latest = LatestBlockhash { blockhash: timba_protocol::Address([1; 32]), last_valid_block_height: 100 };
        confirm_transaction(&pool, "sig", &latest).await.unwrap();

        transport.push(
            "getSignatureStatuses",
            Ok(json!({"value": [{"slot": 1, "err": {"InstructionError": [0, "Custom"]}}]})),
        );
        let err = confirm_transaction(&pool, "sig", &latest).await.unwrap_err();
        assert_eq!(err.to_string(), r#"Transaction sig failed: {"InstructionError":[0,"Custom"]}"#);

        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        let expired = LatestBlockhash { last_valid_block_height: 5, ..latest };
        let err = confirm_transaction(&pool, "sig", &expired).await.unwrap_err();
        assert_eq!(err.to_string(), "Transaction sig expired before confirmation");
    }

    #[tokio::test]
    async fn retries_once_after_expiry() {
        let transport = FakeTransport::new();
        transport.on(|_, m, _| (m == "getLatestBlockhash").then(|| Ok(blockhash())));
        transport.push(
            "sendTransaction",
            Err(RpcError::json_rpc(-32002, "Transaction simulation failed: Blockhash not found")),
        );
        transport.push("sendTransaction", Ok(json!("sig2")));
        transport.on(|_, m, _| (m == "getBlockHeight").then(|| Ok(json!(1))));
        transport.on(|_, m, _| {
            (m == "getSignatureStatuses")
                .then(|| Ok(json!({"value": [{"slot": 1, "confirmationStatus": "finalized"}]})))
        });
        let pool = RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap();
        let signed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let s = signed.clone();
        let signature = submit_transaction(
            &pool,
            |_| {
                s.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok("wire".into())
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(signature, "sig2");
        assert_eq!(signed.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(transport.calls_for("getLatestBlockhash").len(), 2);
    }
}
