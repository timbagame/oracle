//! Durable verification records plus bounded, deduplicated backfills
//! (port of `web-api/cache.ts`). Failures are never cached.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::Value;

use crate::indexer::schema::to_js_json;

pub type ReadRecord = Arc<dyn Fn(&str) -> Result<Option<String>> + Send + Sync>;
pub type WriteRecord = Arc<dyn Fn(&str, &str) -> Result<()> + Send + Sync>;
pub type LoadRecord = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Value>> + Send + Sync>;

type PendingLoad = Shared<BoxFuture<'static, Result<Value, String>>>;

pub const DEFAULT_CONCURRENCY: usize = 2;

pub struct VerificationLoaderOptions {
    pub read: ReadRecord,
    pub write: WriteRecord,
    pub load: LoadRecord,
    pub namespace: String,
    /// Defaults to [`DEFAULT_CONCURRENCY`].
    pub concurrency: Option<usize>,
}

/// `createVerificationLoader`.
pub struct VerificationLoader {
    read: ReadRecord,
    write: WriteRecord,
    load: LoadRecord,
    namespace: String,
    concurrency: usize,
    pending: Arc<Mutex<HashMap<String, (u64, PendingLoad)>>>,
    next_id: AtomicU64,
}

impl VerificationLoader {
    pub fn new(options: VerificationLoaderOptions) -> Self {
        Self {
            read: options.read,
            write: options.write,
            load: options.load,
            namespace: options.namespace,
            concurrency: options.concurrency.unwrap_or(DEFAULT_CONCURRENCY),
            pending: Arc::default(),
            next_id: AtomicU64::new(0),
        }
    }

    pub fn key(&self, signature: &str) -> String {
        format!("{}:verification-v2:{signature}", self.namespace)
    }

    /// Returns the durable record, joins a running load for the same
    /// signature, or starts a new one when capacity allows.
    pub async fn get(&self, signature: &str) -> Result<Value> {
        let key = self.key(signature);
        if let Some(cached) = (self.read)(&key)?.filter(|cached| !cached.is_empty()) {
            return Ok(serde_json::from_str(&cached)?);
        }
        let task = {
            let mut pending = self.pending.lock().unwrap();
            if let Some((_, running)) = pending.get(&key) {
                running.clone()
            } else {
                if pending.len() >= self.concurrency {
                    return Err(anyhow!("Verification capacity reached"));
                }
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let load = (self.load)(signature.to_string());
                let write = self.write.clone();
                let registry = self.pending.clone();
                let record_key = key.clone();
                // The load runs to completion even if every waiting request goes away.
                let handle = tokio::spawn(async move {
                    let result = async {
                        let value = load.await?;
                        write(&record_key, &to_js_json(&value))?;
                        Ok::<_, anyhow::Error>(value)
                    }
                    .await
                    .map_err(|error| format!("{error:#}"));
                    let mut pending = registry.lock().unwrap();
                    if pending.get(&record_key).is_some_and(|(owner, _)| *owner == id) {
                        pending.remove(&record_key);
                    }
                    result
                });
                let task: PendingLoad =
                    async move { handle.await.map_err(|error| error.to_string())? }.boxed().shared();
                pending.insert(key, (id, task.clone()));
                task
            }
        };
        task.await.map_err(|message| anyhow!(message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::IndexerDatabase;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::oneshot;

    fn database_options(db: Arc<IndexerDatabase>, load: LoadRecord, namespace: &str) -> VerificationLoaderOptions {
        let (reader, writer) = (db.clone(), db);
        VerificationLoaderOptions {
            read: Arc::new(move |key| reader.get_verified_game(key)),
            write: Arc::new(move |key, value| writer.save_verified_game(key, value)),
            load,
            namespace: namespace.into(),
            concurrency: None,
        }
    }

    #[tokio::test]
    async fn coalesces_misses_and_serves_durable_records_without_another_reconstruction() {
        let db = Arc::new(IndexerDatabase::open(":memory:").unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let load: LoadRecord = Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::task::yield_now().await;
                Ok(json!({ "winner": "synthetic" }))
            }
            .boxed()
        });
        let loader = VerificationLoader::new(database_options(db.clone(), load.clone(), "synthetic-program"));
        let (first, second) = tokio::join!(loader.get("same"), loader.get("same"));
        assert_eq!(first.unwrap(), json!({ "winner": "synthetic" }));
        assert_eq!(second.unwrap(), json!({ "winner": "synthetic" }));
        let fresh = VerificationLoader::new(database_options(db.clone(), load, "synthetic-program"));
        assert_eq!(fresh.get("same").await.unwrap(), json!({ "winner": "synthetic" }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(db.get_verified_game("synthetic-program:verification-v2:same").unwrap().is_some());
        db.close();
    }

    #[tokio::test]
    async fn bounds_work_and_never_caches_failed_reconstructions() {
        let writes = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorded = writes.clone();
        let write: WriteRecord = Arc::new(move |key, _| {
            recorded.lock().unwrap().push(key.to_string());
            Ok(())
        });
        let (resolve, receiver) = oneshot::channel::<()>();
        let receiver = Arc::new(Mutex::new(Some(receiver)));
        let bounded = VerificationLoader::new(VerificationLoaderOptions {
            read: Arc::new(|_| Ok(None)),
            write: write.clone(),
            load: Arc::new(move |_| {
                let receiver = receiver.lock().unwrap().take().expect("single load");
                async move {
                    receiver.await.ok();
                    Ok(json!("ok"))
                }
                .boxed()
            }),
            namespace: "test".into(),
            concurrency: Some(1),
        });
        let first = bounded.get("first");
        let mut first = Box::pin(first);
        assert!(futures::poll!(first.as_mut()).is_pending());
        let error = bounded.get("second").await.unwrap_err();
        assert!(error.to_string().contains("capacity"));
        resolve.send(()).unwrap();
        assert_eq!(first.await.unwrap(), json!("ok"));

        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let failing = VerificationLoader::new(VerificationLoaderOptions {
            read: Arc::new(|_| Ok(None)),
            write,
            load: Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                async { Err(anyhow!("missing history")) }.boxed()
            }),
            namespace: "test".into(),
            concurrency: None,
        });
        assert!(failing.get("missing").await.is_err());
        assert!(failing.get("missing").await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(writes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn propagates_read_failures_and_ignores_empty_records() {
        let loader = VerificationLoader::new(VerificationLoaderOptions {
            read: Arc::new(|key| Ok(key.ends_with("empty").then(String::new))),
            write: Arc::new(|_, _| Ok(())),
            load: Arc::new(|signature| async move { Ok(json!({ "signature": signature })) }.boxed()),
            namespace: "ns".into(),
            concurrency: None,
        });
        assert_eq!(loader.get("empty").await.unwrap(), json!({ "signature": "empty" }));
        let broken = VerificationLoader::new(VerificationLoaderOptions {
            read: Arc::new(|_| Err(anyhow!("database is closed"))),
            write: Arc::new(|_, _| Ok(())),
            load: Arc::new(|_| async { Ok(json!(null)) }.boxed()),
            namespace: "ns".into(),
            concurrency: None,
        });
        assert!(broken.get("x").await.is_err());
    }
}
