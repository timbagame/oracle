//! Transaction confirmation polling and expiry-aware submission (ports of
//! `confirmTransaction` and `TransactionSubmitter`).

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use timba_common::warn;
use tokio::time::Instant;

use super::pool::RpcPool;
use super::rpc::LatestBlockhash;

pub const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// How often an unconfirmed transaction is sent again, and the expiry checked. RPC nodes
/// drop unstaked transactions under load, and a dropped one otherwise only shows up once
/// its blockhash expires, about a minute later.
pub const REBROADCAST_INTERVAL: Duration = Duration::from_secs(2);

/// Polls signature status until the transaction is confirmed, fails, expires
/// or times out.
pub async fn confirm_transaction(rpc: &RpcPool, signature: &str, latest: &LatestBlockhash) -> anyhow::Result<()> {
    confirm(rpc, signature, latest, None).await
}

/// [`confirm_transaction`] that also rebroadcasts `wire` to every endpoint until it lands.
async fn confirm(rpc: &RpcPool, signature: &str, latest: &LatestBlockhash, wire: Option<&str>) -> anyhow::Result<()> {
    let deadline = Instant::now() + CONFIRMATION_TIMEOUT;
    // The first round also fans the transaction out to every endpoint right away.
    let mut next_check = Instant::now();
    let signatures = [signature.to_string()];
    while Instant::now() < deadline {
        if let Some(Some(status)) = rpc.get_signature_statuses(&signatures).await?.first() {
            if let Some(err) = &status.err {
                anyhow::bail!("Transaction {signature} failed: {}", serde_json::to_string(err).unwrap_or_default());
            }
            if status.is_confirmed() {
                return Ok(());
            }
        }
        if Instant::now() >= next_check {
            next_check = Instant::now() + REBROADCAST_INTERVAL;
            if rpc.get_block_height().await? > latest.last_valid_block_height {
                anyhow::bail!("Transaction {signature} expired before confirmation");
            }
            if let Some(wire) = wire {
                rpc.broadcast_transaction(wire).await;
            }
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

/// Signs with a fresh blockhash, sends, rebroadcasts and confirms; retries once with a
/// new blockhash when the first attempt expired, unless the expired transaction actually
/// landed. `sign` runs once per attempt, so it can raise the priority fee on the retry.
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
    confirm(rpc, &signature, latest, Some(&wire)).await?;
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

    fn expired_pool(transport: &Arc<FakeTransport>) -> RpcPool {
        transport.on(|_, m, _| (m == "getLatestBlockhash").then(|| Ok(blockhash())));
        transport.on(|_, m, _| (m == "sendTransaction").then(|| Ok(json!("sig"))));
        // The first confirmation poll sees the chain past the blockhash, later ones do not.
        transport.push("getBlockHeight", Ok(json!(200)));
        transport.on(|_, m, _| (m == "getBlockHeight").then(|| Ok(json!(1))));
        RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap()
    }

    /// `sendTransaction` calls with preflight, leaving out the rebroadcasts.
    fn sends(transport: &FakeTransport) -> usize {
        transport.calls_for("sendTransaction").iter().filter(|(_, params)| params[1]["skipPreflight"] == false).count()
    }

    fn confirmed() -> serde_json::Value {
        json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_when_the_transaction_never_confirms() {
        let transport = FakeTransport::new();
        transport.on(|_, m, _| (m == "getBlockHeight").then(|| Ok(json!(10))));
        transport.on(|_, m, _| {
            (m == "getSignatureStatuses")
                .then(|| Ok(json!({"value": [{"slot": 1, "confirmationStatus": "processed", "err": null}]})))
        });
        let pool = RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap();
        let latest = LatestBlockhash { blockhash: timba_protocol::Address([1; 32]), last_valid_block_height: 100 };
        let started = Instant::now();
        let err = confirm_transaction(&pool, "sig", &latest).await.unwrap_err();
        assert_eq!(err.to_string(), "Transaction sig confirmation timed out");
        assert!(started.elapsed() >= CONFIRMATION_TIMEOUT);
        let polls = transport.calls_for("getSignatureStatuses").len();
        assert!((150..=151).contains(&polls), "one poll every 400ms: {polls}");
        let checks = transport.calls_for("getBlockHeight").len();
        assert!((30..=31).contains(&checks), "one expiry check every 2s: {checks}");
    }

    #[tokio::test]
    async fn expired_transactions_are_resent_when_they_did_not_land() {
        let transport = FakeTransport::new();
        let pool = expired_pool(&transport);
        // Unknown at first, still unknown when checked after the expiry, then confirmed.
        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        transport.push("getSignatureStatuses", Ok(json!({"value": [{"slot": 1, "confirmationStatus": "processed"}]})));
        transport.on(|_, m, _| (m == "getSignatureStatuses").then(|| Ok(confirmed())));
        let retries = std::sync::Mutex::new(Vec::new());
        let on_retry = |error: &anyhow::Error| retries.lock().unwrap().push(error.to_string());
        let signature = submit_transaction(&pool, |_| Ok("wire".into()), Some(&on_retry)).await.unwrap();
        assert_eq!(signature, "sig");
        assert_eq!(*retries.lock().unwrap(), vec!["Transaction sig expired before confirmation"]);
        assert_eq!(sends(&transport), 2);
    }

    #[tokio::test]
    async fn expired_transactions_are_resent_when_the_node_has_never_seen_them() {
        let transport = FakeTransport::new();
        let pool = expired_pool(&transport);
        // Unknown while confirming and still unknown after the expiry.
        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        transport.on(|_, m, _| (m == "getSignatureStatuses").then(|| Ok(confirmed())));
        assert_eq!(submit_transaction(&pool, |_| Ok("wire".into()), None).await.unwrap(), "sig");
        assert_eq!(sends(&transport), 2);
    }

    #[tokio::test]
    async fn expired_transactions_are_resent_when_their_status_is_unavailable() {
        let transport = FakeTransport::new();
        let pool = expired_pool(&transport);
        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        transport.push("getSignatureStatuses", Err(RpcError::json_rpc(-32602, "status lookup rejected")));
        transport.on(|_, m, _| (m == "getSignatureStatuses").then(|| Ok(confirmed())));
        assert_eq!(submit_transaction(&pool, |_| Ok("wire".into()), None).await.unwrap(), "sig");
        assert_eq!(sends(&transport), 2);
    }

    #[tokio::test]
    async fn expired_transactions_that_landed_are_not_resent() {
        let transport = FakeTransport::new();
        let pool = expired_pool(&transport);
        transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        transport.on(|_, m, _| (m == "getSignatureStatuses").then(|| Ok(confirmed())));
        assert_eq!(submit_transaction(&pool, |_| Ok("wire".into()), None).await.unwrap(), "sig");
        assert_eq!(sends(&transport), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_transactions_are_rebroadcast_to_every_endpoint_until_they_land() {
        // Regression: a dropped completion used to wait for its blockhash to expire
        // (about 35 seconds) before anything was sent again.
        let transport = FakeTransport::new();
        transport.on(|_, m, _| (m == "getLatestBlockhash").then(|| Ok(blockhash())));
        transport.on(|_, m, _| (m == "getBlockHeight").then(|| Ok(json!(10))));
        transport.on(|endpoint, m, _| {
            (m == "sendTransaction").then(|| {
                if endpoint == "https://b" {
                    Err(RpcError::transport("b is down"))
                } else {
                    Ok(json!("sig"))
                }
            })
        });
        // Unknown for the first 4.4 seconds, then confirmed.
        for _ in 0..11 {
            transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        }
        transport.on(|_, m, _| (m == "getSignatureStatuses").then(|| Ok(confirmed())));
        let pool = RpcPool::with_transport(&["https://a".into(), "https://b".into()], transport.clone()).unwrap();
        let started = Instant::now();
        assert_eq!(submit_transaction(&pool, |_| Ok("wire".into()), None).await.unwrap(), "sig");
        assert_eq!(started.elapsed(), POLL_INTERVAL * 11);
        assert_eq!(sends(&transport), 1);
        let rebroadcasts: Vec<_> = transport
            .calls_for("sendTransaction")
            .into_iter()
            .filter(|(_, params)| params[1]["skipPreflight"] == true)
            .collect();
        // Right away, after 2s and after 4s, to both endpoints, even though one keeps failing.
        assert_eq!(rebroadcasts.len(), 6);
        assert_eq!(rebroadcasts.iter().filter(|(endpoint, _)| endpoint == "https://b").count(), 3);
        assert!(rebroadcasts.iter().all(|(_, params)| params[0] == "wire" && params[1]["maxRetries"] == 0));
    }
}
