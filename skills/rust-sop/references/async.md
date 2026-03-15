# Async Rust — Tokio Patterns for Clawnode

## Runtime Setup

```rust
// Default: multi-thread (daemon, server)
#[tokio::main]
async fn main() -> anyhow::Result<()> { ... }

// Single-thread for tests
#[tokio::test]
async fn test_something() { ... }

// Custom runtime (when you need control)
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(4)
    .thread_name("clawnode-worker")
    .enable_all()
    .build()?;
```

## Graceful Shutdown (Daemon Pattern)

This is the core pattern for clawnode — multiple long-running tasks that need coordinated shutdown:

```rust
use tokio::sync::watch;
use tokio::signal;

async fn run_daemon(config: Config) -> anyhow::Result<()> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Spawn all subsystems
    let server = tokio::spawn(run_xrpc_server(config.clone(), shutdown_rx.clone()));
    let heartbeat = tokio::spawn(run_heartbeat(config.clone(), shutdown_rx.clone()));
    let firehose = tokio::spawn(run_firehose_subscriber(config.clone(), shutdown_rx.clone()));
    let socket = tokio::spawn(run_unix_socket(config.clone(), shutdown_rx));

    // Wait for shutdown signal
    shutdown_signal().await;
    tracing::info!("shutdown signal received, draining...");
    let _ = shutdown_tx.send(true);

    // Wait for all tasks with timeout
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        futures::future::join_all([server, heartbeat, firehose, socket]),
    ).await;

    tracing::info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = signal::ctrl_c();
    #[cfg(unix)]
    let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
        .expect("failed to install SIGTERM handler");

    tokio::select! {
        _ = ctrl_c => {},
        #[cfg(unix)]
        _ = sigterm.recv() => {},
    }
}
```

## Cancellable Loop Pattern

Every long-running subsystem uses this shape:

```rust
async fn run_heartbeat(config: Config, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Err(e) = send_presence(&config).await {
                    tracing::warn!(error = %e, "heartbeat failed");
                    // Don't crash — retry on next tick
                }
            }
            _ = shutdown.changed() => {
                tracing::info!("heartbeat shutting down");
                break;
            }
        }
    }
}
```

## Concurrent Execution

```rust
// join! — run concurrently, wait for all
let (users, posts) = tokio::join!(
    fetch_users(&db),
    fetch_posts(&db),
);

// try_join! — stop on first error
let (users, posts) = tokio::try_join!(
    fetch_users(&db),
    fetch_posts(&db),
)?;

// select! — first to complete wins (others cancelled)
tokio::select! {
    result = fetch_from_primary() => handle(result),
    result = fetch_from_replica() => handle(result),
    _ = tokio::time::sleep(Duration::from_secs(5)) => {
        return Err(anyhow::anyhow!("timeout"));
    }
}

// Spawn for fire-and-forget with JoinHandle
let handle = tokio::spawn(async move {
    expensive_work().await
});
let result = handle.await?; // JoinError if task panics
```

## Channels

| Type | Pattern | Use Case |
|------|---------|----------|
| `mpsc` | Many→One | Worker pool results, event aggregation |
| `oneshot` | One→One | Request/response, task completion signal |
| `broadcast` | One→Many | Config changes, shutdown signals |
| `watch` | One→Many (latest) | Shutdown flag, live config, health state |

```rust
// mpsc: event processing pipeline
let (tx, mut rx) = tokio::sync::mpsc::channel::<Event>(256);

// Producer
tokio::spawn(async move {
    tx.send(Event::RecordCreated { ... }).await?;
});

// Consumer
while let Some(event) = rx.recv().await {
    process_event(event).await;
}

// watch: health state (readers always get latest)
let (health_tx, health_rx) = watch::channel(HealthState::Starting);
// Writer: health_tx.send(HealthState::Ready)?;
// Reader: let current = *health_rx.borrow();
```

## Shared State

```rust
// Arc<tokio::sync::Mutex<T>> for async-safe shared mutable state
let shared = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

// CRITICAL: never hold lock across .await
// BAD:
let mut guard = shared.lock().await;
some_async_op().await; // ← deadlock risk
// GOOD:
let value = {
    let guard = shared.lock().await;
    guard.get("key").cloned()
};
some_async_op_with(value).await;

// RwLock for read-heavy workloads (service registry)
let registry = Arc::new(tokio::sync::RwLock::new(ServiceRegistry::new()));
// Many readers: registry.read().await
// Rare writer: registry.write().await
```

## Blocking Work

```rust
// CPU-bound: spawn_blocking (runs on dedicated thread pool)
let hash = tokio::task::spawn_blocking(move || {
    compute_hash(&data) // CPU-intensive, would block async runtime
}).await?;

// File I/O: tokio::fs (async wrappers around blocking FS ops)
let content = tokio::fs::read_to_string("config.toml").await?;

// External process
let output = tokio::process::Command::new("git")
    .args(["rev-parse", "HEAD"])
    .output()
    .await?;
```

## Timeouts and Retries

```rust
// Timeout any future
let result = tokio::time::timeout(
    Duration::from_secs(5),
    fetch_remote_data(),
).await.map_err(|_| anyhow::anyhow!("operation timed out"))?;

// Retry with exponential backoff
async fn with_retry<F, Fut, T, E>(f: F, max_retries: u32) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: Future<Result<T, E>>,
    E: std::fmt::Display,
{
    let mut delay = Duration::from_millis(100);
    for attempt in 0..max_retries {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < max_retries - 1 => {
                tracing::warn!(attempt, error = %e, "retrying after {:?}", delay);
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}
```

## WebSocket (Firehose Pattern)

```rust
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};

async fn subscribe_firehose(url: &str, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    loop {
        let (mut ws, _) = connect_async(url).await?;
        tracing::info!("connected to firehose");

        loop {
            tokio::select! {
                msg = ws.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            process_firehose_event(&text).await;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::warn!("firehose connection closed, reconnecting...");
                            break; // break inner loop, reconnect in outer
                        }
                        Some(Err(e)) => {
                            tracing::error!(error = %e, "firehose error");
                            break;
                        }
                        _ => {}
                    }
                }
                _ = shutdown.changed() => {
                    tracing::info!("firehose shutting down");
                    let _ = ws.close(None).await;
                    return Ok(());
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(5)).await; // backoff before reconnect
    }
}
```

## Async Traits

```rust
// Rust 1.75+: native async fn in traits (use this when possible)
trait RecordStore: Send + Sync {
    async fn get(&self, collection: &str, rkey: &str) -> Result<Option<Record>>;
    async fn put(&self, record: Record) -> Result<()>;
}

// When you need dyn dispatch (trait objects): use async-trait
use async_trait::async_trait;

#[async_trait]
trait ServiceRegistry: Send + Sync {
    async fn discover(&self, service: &str) -> Result<Vec<ServiceEntry>>;
}

// async-trait works with Box<dyn ServiceRegistry>
// Native async fn in traits does NOT (yet) support dyn dispatch
```

## Testing Async Code

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_record_store() {
        let db = setup_test_db().await;
        let store = LibSqlRecordStore::new(db);

        store.put(Record { ... }).await.unwrap();
        let found = store.get("collection", "rkey").await.unwrap();
        assert!(found.is_some());
    }

    #[tokio::test]
    async fn test_timeout() {
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            tokio::time::sleep(Duration::from_secs(10)),
        ).await;
        assert!(result.is_err()); // timed out
    }
}
```

## Rules

- **Never block the async runtime**: Use `spawn_blocking` for CPU work, `tokio::fs` for file I/O
- **Never hold Mutex across .await**: Clone data out, drop lock, then await
- **Always timeout external I/O**: Network, process, file — all can hang forever
- **Use watch for shutdown**: Every subsystem gets a `watch::Receiver<bool>`
- **Handle JoinError**: Spawned tasks can panic — `.await?` on JoinHandle
- **Prefer channels over shared state**: mpsc/oneshot are usually cleaner than Arc<Mutex<T>>
- **Log at warn level on retry, error on final failure**: Don't spam errors for transient issues
