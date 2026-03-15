---
name: rust-sop
displayName: Rust SOP
description: "Standard operating procedures for writing Rust in joelclaw. Covers idiomatic patterns, async/tokio, error handling, project structure, testing, and clawnode-specific conventions. Use when writing Rust code, reviewing Rust PRs, scaffolding Rust projects, debugging ownership/lifetime errors, or working on clawnode. Triggers on: 'rust', 'cargo', 'tokio', 'axum', 'clawnode', 'ownership', 'lifetimes', 'borrow checker', 'rust error', or any Rust development task."
version: 0.1.0
author: joel
tags:
  - rust
  - systems
  - clawnode
  - language
---

# Rust SOP — joelclaw Standard Operating Procedures

Idiomatic Rust patterns and conventions for all Rust code in joelclaw. Primary consumer: clawnode (embedded PDS + mesh daemon). Written for agent workers — include this skill when delegating Rust work to codex.

## Project Conventions

### Stack

| Layer | Crate | Notes |
|-------|-------|-------|
| Runtime | `tokio` | Multi-thread by default, `current_thread` for tests |
| HTTP | `axum` | XRPC endpoints, health checks |
| Database | `libsql` | Local-first, native vector search (F32_BLOB, DiskANN) |
| Serialization | `serde` + `serde_json` | All AT Proto records are JSON |
| Error handling | `thiserror` (libraries), `anyhow` (binaries) | Never `unwrap()` in production |
| CLI | `clap` (derive) | Single binary: daemon + CLI subcommands |
| Logging | `tracing` + `tracing-subscriber` | Structured, not println |
| Testing | built-in + `tokio::test` | Property tests with `proptest` where useful |
| AT Proto types | `atrium` crates | Code-generated from lexicons |

### Project Structure

```
clawnode/
├── Cargo.toml
├── src/
│   ├── main.rs              # CLI entry, clap dispatch
│   ├── lib.rs               # Public API surface
│   ├── daemon/              # Long-running daemon logic
│   │   ├── mod.rs
│   │   ├── server.rs        # Axum HTTP server (XRPC)
│   │   ├── firehose.rs      # WebSocket subscribeRepos
│   │   └── heartbeat.rs     # Presence + health
│   ├── pds/                 # Embedded PDS
│   │   ├── mod.rs
│   │   ├── repo.rs          # MST / record storage
│   │   ├── records.rs       # CRUD operations
│   │   └── auth.rs          # Session management
│   ├── storage/             # libSQL abstraction
│   │   ├── mod.rs
│   │   ├── migrations.rs    # Schema migrations
│   │   └── vectors.rs       # Vector search helpers
│   ├── mesh/                # Service discovery + proxy
│   │   ├── mod.rs
│   │   ├── registry.rs      # ServiceRegistry trait
│   │   └── proxy.rs         # Redis/Typesense/Inngest proxy
│   ├── socket/              # Unix socket JSON-RPC
│   │   └── mod.rs
│   └── cli/                 # CLI subcommands
│       ├── mod.rs
│       ├── status.rs
│       ├── recall.rs
│       └── send.rs
├── tests/
│   ├── integration/
│   └── common/
└── migrations/
    └── 001_initial.sql
```

### Naming Conventions

- **Crate name**: `clawnode` (binary), internal lib crate also `clawnode`
- **Modules**: snake_case, flat where possible (`storage.rs` not `storage/mod.rs` unless submodules needed)
- **Types**: PascalCase. Prefix domain types: `PdsRecord`, `MeshNode`, `ServiceEntry`
- **Traits**: Adjective or noun (`Discoverable`, `ServiceRegistry`, `RecordStore`)
- **Error enums**: `<Module>Error` (`StorageError`, `PdsError`, `MeshError`)
- **Constants**: SCREAMING_SNAKE_CASE

## Core Patterns

### Error Handling

```rust
// Library code: thiserror for typed errors
#[derive(thiserror::Error, Debug)]
pub enum PdsError {
    #[error("record not found: {collection}/{rkey}")]
    NotFound { collection: String, rkey: String },
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("invalid record: {0}")]
    InvalidRecord(String),
}

// Application/binary code: anyhow for ergonomic error chains
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let config = load_config()
        .context("failed to load clawnode config")?;
    Ok(())
}
```

**Rules:**
- Never `unwrap()` in production code. Use `expect("reason")` only for truly invariant conditions.
- Use `?` operator everywhere. Add `.context("what failed")` for anyhow chains.
- Map errors at boundary layers (e.g., `PdsError` → `axum::response::IntoResponse`).

### Ownership & Borrowing

```rust
// Prefer borrowing for function params
fn process_record(record: &PdsRecord) -> Result<()> { ... }

// Use &str not String for read-only string params
fn find_by_collection(collection: &str) -> Result<Vec<PdsRecord>> { ... }

// Use &[T] not Vec<T> for read-only slice params
fn batch_insert(records: &[PdsRecord]) -> Result<usize> { ... }

// Return owned types from constructors/builders
fn create_record(collection: String, rkey: String, value: serde_json::Value) -> PdsRecord { ... }

// Cow for conditional cloning
use std::borrow::Cow;
fn normalize_handle(handle: &str) -> Cow<str> {
    if handle.starts_with("did:") {
        Cow::Borrowed(handle)
    } else {
        Cow::Owned(format!("at://{handle}"))
    }
}
```

### Async / Tokio

```rust
// Default: multi-thread runtime
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ...
}

// Graceful shutdown pattern (critical for daemon)
async fn run_daemon(config: Config) -> anyhow::Result<()> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let server = tokio::spawn(run_server(config.clone(), shutdown_rx.clone()));
    let heartbeat = tokio::spawn(run_heartbeat(config.clone(), shutdown_rx.clone()));
    let firehose = tokio::spawn(run_firehose(config.clone(), shutdown_rx));

    // Wait for ctrl-c
    tokio::signal::ctrl_c().await?;
    tracing::info!("shutdown signal received");
    shutdown_tx.send(true)?;

    // Wait for all tasks
    let _ = tokio::join!(server, heartbeat, firehose);
    Ok(())
}

// Use select! for cancellable operations
async fn run_heartbeat(config: Config, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Err(e) = send_heartbeat(&config).await {
                    tracing::warn!("heartbeat failed: {e}");
                }
            }
            _ = shutdown.changed() => {
                tracing::info!("heartbeat shutting down");
                break;
            }
        }
    }
}

// spawn_blocking for CPU-bound work (embeddings, hashing)
let embedding = tokio::task::spawn_blocking(move || {
    compute_embedding(&text)
}).await?;

// Never hold a Mutex guard across .await
// BAD:
let mut guard = data.lock().await;
some_async_op().await; // ← deadlock risk
// GOOD:
let value = {
    let guard = data.lock().await;
    guard.clone()
};
some_async_op_with(value).await;
```

### Traits & Hexagonal Architecture

```rust
// Define ports as traits
#[async_trait::async_trait]
pub trait ServiceRegistry: Send + Sync {
    async fn discover(&self, service: &str) -> Result<Vec<ServiceEntry>>;
    async fn register(&self, entry: ServiceEntry) -> Result<()>;
    async fn deregister(&self, node_id: &str) -> Result<()>;
}

#[async_trait::async_trait]
pub trait RecordStore: Send + Sync {
    async fn get(&self, collection: &str, rkey: &str) -> Result<Option<PdsRecord>>;
    async fn list(&self, collection: &str, limit: usize) -> Result<Vec<PdsRecord>>;
    async fn put(&self, record: PdsRecord) -> Result<()>;
    async fn delete(&self, collection: &str, rkey: &str) -> Result<bool>;
}

// Implement adapters
pub struct LibSqlRecordStore { db: libsql::Database }
pub struct StaticServiceRegistry { services: HashMap<String, Vec<ServiceEntry>> }
pub struct PdsServiceRegistry { client: AtpAgent }

// Wire in main.rs (composition root)
let store = LibSqlRecordStore::new("clawnode.db").await?;
let registry = StaticServiceRegistry::from_config(&config);
let daemon = Daemon::new(store, registry);
```

### Structured Logging

```rust
use tracing::{info, warn, error, debug, instrument};

// Instrument async functions
#[instrument(skip(db), fields(collection = %collection))]
async fn list_records(db: &impl RecordStore, collection: &str) -> Result<Vec<PdsRecord>> {
    let records = db.list(collection, 100).await?;
    info!(count = records.len(), "listed records");
    Ok(records)
}

// Subscriber setup
fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clawnode=info,tower_http=info".into())
        )
        .with_target(false)
        .json() // structured output for daemon mode
        .init();
}
```

### libSQL + Vector Search

```rust
use libsql::Builder;

async fn init_db(path: &str) -> anyhow::Result<libsql::Database> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;

    // Run migrations
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS observations (
            uri TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            category TEXT,
            tags TEXT,
            embedding F32_BLOB(384),
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS obs_vec_idx
            ON observations (libsql_vector_idx(embedding, 'metric=cosine'));
    ").await?;

    Ok(db)
}

// Vector recall
async fn recall(conn: &libsql::Connection, embedding: &[f32], k: usize) -> Result<Vec<Observation>> {
    let embedding_str = format!("[{}]", embedding.iter()
        .map(|f| f.to_string())
        .collect::<Vec<_>>()
        .join(","));

    let mut rows = conn.query(
        "SELECT content, category, tags FROM vector_top_k('obs_vec_idx', vector32(?1), ?2)
         JOIN observations ON observations.rowid = id",
        libsql::params![embedding_str, k as i64],
    ).await?;

    let mut results = Vec::new();
    while let Some(row) = rows.next().await? {
        results.push(Observation {
            content: row.get(0)?,
            category: row.get(1)?,
            tags: row.get(2)?,
        });
    }
    Ok(results)
}
```

### Axum HTTP Server

```rust
use axum::{Router, Json, extract::State};

fn xrpc_routes(state: AppState) -> Router {
    Router::new()
        .route("/xrpc/com.atproto.repo.createRecord", post(create_record))
        .route("/xrpc/com.atproto.repo.getRecord", get(get_record))
        .route("/xrpc/com.atproto.repo.listRecords", get(list_records))
        .route("/xrpc/com.atproto.repo.deleteRecord", post(delete_record))
        .route("/xrpc/com.atproto.repo.describeRepo", get(describe_repo))
        .route("/_health", get(health))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "did": state.did,
        "uptime_secs": state.start_time.elapsed().as_secs(),
    }))
}
```

## Validation Checklist

Every Rust change must pass:

```bash
cargo fmt --check                          # formatting
cargo clippy --all-targets --all-features  # lints (zero warnings)
cargo test                                 # all tests
cargo test --doc                           # doctests
```

For clawnode specifically:
```bash
cargo build --release                      # ensure release builds clean
cargo clippy -- -D warnings                # treat warnings as errors in CI
```

## Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| `unwrap()` in prod | `expect("reason")` or `?` with context |
| `println!` for logging | `tracing::info!` with structured fields |
| `String` params when reading | `&str` params |
| `Vec<T>` params when reading | `&[T]` params |
| `clone()` without thinking | Borrow first, clone only when ownership required |
| `unsafe` without `// SAFETY:` comment | Document the invariant or find a safe alternative |
| Holding locks across `.await` | Clone data out, drop lock, then await |
| Blocking calls in async context | `tokio::task::spawn_blocking` |
| Manual `for` loops for transforms | Iterator combinators (`.map`, `.filter`, `.collect`) |
| `async-trait` when not needed | Native async fn in traits (Rust 1.75+) |

## Library-First Development (MANDATORY)

Before writing non-trivial Rust code, **search the pdf-brain library**. It contains chunked, indexed content from the best Rust books. This is not optional — the library has authoritative patterns that are better than what you'll generate from training data.

```bash
# Search the library
joelclaw docs search "tokio graceful shutdown signal"

# Get full context around a result
joelclaw docs context <chunk-id> --mode snippet-window
```

**Load `references/library.md` for the full search playbook** — it has few-shot examples for every Rust domain (ownership, async, traits, axum, testing, systems).

Quick examples:
```bash
# Before implementing error types:
joelclaw docs search "thiserror custom error types"

# Before writing async code:
joelclaw docs search "tokio spawn select join"

# Before designing a trait:
joelclaw docs search "trait objects dynamic dispatch dyn"

# When stuck on a compiler error:
joelclaw docs search "borrow checker mutable immutable reference"
```

## References

Load these for deeper guidance on specific topics:

| Topic | File |
|-------|------|
| Ownership & lifetimes | `references/ownership.md` |
| **Async / Tokio patterns** | **`references/async.md`** — graceful shutdown, cancellable loops, channels, shared state, WebSocket, retries |
| **Axum HTTP server** | **`references/axum.md`** — routing, extractors, custom auth, error→response, WebSocket firehose, middleware, testing |
| Common compiler errors | `references/compiler-errors.md` |
| **pdf-brain search playbook** | **`references/library.md`** |
