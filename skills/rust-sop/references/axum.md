# Axum — HTTP Server Patterns for Clawnode

Clawnode uses Axum for XRPC endpoints (AT Proto), health checks, and the WebSocket firehose. These patterns are production-grade.

## Application Structure

```rust
use axum::{Router, routing::{get, post}, extract::State};
use std::sync::Arc;
use tower_http::{
    compression::CompressionLayer,
    trace::TraceLayer,
    timeout::TimeoutLayer,
};

#[derive(Clone)]
struct AppState {
    db: libsql::Database,
    did: String,
    registry: Arc<dyn ServiceRegistry>,
    start_time: std::time::Instant,
}

fn build_router(state: AppState) -> Router {
    Router::new()
        // XRPC routes
        .route("/xrpc/com.atproto.repo.createRecord", post(create_record))
        .route("/xrpc/com.atproto.repo.getRecord", get(get_record))
        .route("/xrpc/com.atproto.repo.listRecords", get(list_records))
        .route("/xrpc/com.atproto.repo.deleteRecord", post(delete_record))
        .route("/xrpc/com.atproto.repo.describeRepo", get(describe_repo))
        // Firehose WebSocket
        .route("/xrpc/com.atproto.sync.subscribeRepos", get(subscribe_repos_ws))
        // Health
        .route("/_health", get(health))
        // Middleware (bottom-to-top execution order)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::new(std::time::Duration::from_secs(30)))
        .with_state(state)
}

async fn run_server(state: AppState, mut shutdown: tokio::sync::watch::Receiver<bool>) -> anyhow::Result<()> {
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:2583").await?;
    tracing::info!("XRPC server listening on :2583");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move { let _ = shutdown.changed().await; })
        .await?;
    Ok(())
}
```

## Extractors

Extractors pull typed data from requests. Order matters — body extractors must be last.

```rust
use axum::extract::{State, Path, Query, Json};
use serde::Deserialize;

// Path params
async fn get_record(
    State(state): State<AppState>,
    Path((collection, rkey)): Path<(String, String)>,
) -> Result<Json<Record>, AppError> { ... }

// Query params
#[derive(Deserialize)]
struct ListParams {
    collection: String,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn list_records(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<ListResponse>, AppError> { ... }

// JSON body (must be last extractor)
async fn create_record(
    State(state): State<AppState>,
    Json(body): Json<CreateRecordRequest>,
) -> Result<Json<CreateRecordResponse>, AppError> { ... }
```

## Custom Extractors

For XRPC auth, create a custom extractor:

```rust
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

struct AuthenticatedDid(String);

#[async_trait::async_trait]
impl<S: Send + Sync> FromRequestParts<S> for AuthenticatedDid {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let auth = parts.headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let token = auth.strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;

        let did = validate_session_token(token)
            .map_err(|_| AppError::Unauthorized)?;

        Ok(AuthenticatedDid(did))
    }
}

// Use in handler — extracted before body
async fn create_record(
    State(state): State<AppState>,
    auth: AuthenticatedDid,
    Json(body): Json<CreateRecordRequest>,
) -> Result<Json<CreateRecordResponse>, AppError> { ... }
```

## Error Handling

Map domain errors to HTTP responses via `IntoResponse`:

```rust
use axum::response::{IntoResponse, Response};
use axum::http::StatusCode;

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".into()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal server error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal error".into())
            }
        };

        // XRPC error format
        let body = serde_json::json!({
            "error": status.canonical_reason().unwrap_or("Error"),
            "message": message,
        });

        (status, axum::Json(body)).into_response()
    }
}
```

## WebSocket (Firehose)

```rust
use axum::extract::ws::{WebSocket, WebSocketUpgrade, Message};

async fn subscribe_repos_ws(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_firehose(socket, state))
}

async fn handle_firehose(mut socket: WebSocket, state: AppState) {
    let mut rx = state.firehose_tx.subscribe(); // broadcast channel

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Ok(data) => {
                        let msg = Message::Text(serde_json::to_string(&data).unwrap());
                        if socket.send(msg).await.is_err() {
                            break; // client disconnected
                        }
                    }
                    Err(_) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {} // ignore client messages
                }
            }
        }
    }
}
```

## Middleware

```rust
// Function middleware (simplest)
use axum::{http::Request, middleware::Next, response::Response};

async fn log_request(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let start = std::time::Instant::now();

    let response = next.run(req).await;

    tracing::info!(
        method = %method,
        uri = %uri,
        status = %response.status(),
        duration_ms = %start.elapsed().as_millis(),
    );
    response
}

// Apply: .layer(axum::middleware::from_fn(log_request))

// With state:
// .layer(axum::middleware::from_fn_with_state(state.clone(), auth_middleware))

// Middleware ordering: .layer() calls are bottom-to-top
// ServiceBuilder wraps are top-to-bottom
use tower::ServiceBuilder;
let layers = ServiceBuilder::new()
    .layer(TraceLayer::new_for_http())    // runs first
    .layer(CompressionLayer::new())        // runs second
    .layer(TimeoutLayer::new(Duration::from_secs(30))); // runs third
```

## Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, Method};
    use tower::ServiceExt; // for oneshot()

    #[tokio::test]
    async fn test_health() {
        let state = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(Request::builder().uri("/_health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_create_record() {
        let state = test_state().await;
        let app = build_router(state);

        let body = serde_json::json!({
            "repo": "did:plc:test",
            "collection": "dev.joelclaw.node.presence",
            "record": { "status": "online" }
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/xrpc/com.atproto.repo.createRecord")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer test-token")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap()
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

## Key Crates

| Crate | Use |
|-------|-----|
| `axum` | Framework core |
| `axum-extra` | CookieJar, TypedHeader, protobuf extractors |
| `tower` | ServiceBuilder, Layer trait |
| `tower-http` | TraceLayer, CompressionLayer, CorsLayer, TimeoutLayer |
| `tokio-tungstenite` | WebSocket client (for subscribing to other nodes) |

## Rules

- **State must be Clone**: Use `Arc<T>` for expensive-to-clone fields
- **Body extractors last**: `Json`, `Form`, `Bytes` must be the final extractor
- **Layer order matters**: `.layer()` calls execute bottom-to-top
- **Always return proper errors**: Implement `IntoResponse` for your error type
- **Test with `oneshot()`**: No need to start a real server
- **Graceful shutdown**: Pass `with_graceful_shutdown` to `axum::serve`
