use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{header, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{bridge::BrowserBridge, mcp};

pub struct ServerConfig {
    pub bind: SocketAddr,
    pub token: String,
    pub bridge: BrowserBridge,
}

#[derive(Clone)]
struct AppState {
    bridge: BrowserBridge,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    status: &'static str,
    extension_count: usize,
}

pub async fn serve(config: ServerConfig) -> Result<()> {
    let shutdown = CancellationToken::new();
    let state = AppState {
        bridge: config.bridge,
        token: config.token,
    };

    let mcp_service = mcp::streamable_http_service(state.bridge.clone(), shutdown.child_token());
    let mcp_router = Router::new().nest_service("/mcp", mcp_service).route_layer(
        middleware::from_fn_with_state(state.token.clone(), require_bearer_token),
    );

    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/ws", get(ws))
        .route("/reload-extension", post(reload_extension))
        .merge(mcp_router)
        .with_state(state);

    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("failed to bind {}", config.bind))?;
    let local_addr = listener
        .local_addr()
        .context("failed to read bound server address")?;
    tracing::info!(%local_addr, "server listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(shutdown))
    .await
    .context("server failed")
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(Health {
        status: "ok",
        extension_count: state.bridge.extension_count(),
    })
}

async fn status(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(state.bridge.status())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReloadResult {
    reloaded: usize,
}

async fn reload_extension(State(state): State<AppState>) -> impl IntoResponse {
    let count = state.bridge.reload_all_extensions();
    tracing::info!(count, "reload extension requested");
    axum::Json(ReloadResult { reloaded: count })
}

async fn ws(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_ws(socket, state, peer_addr))
}

async fn handle_ws(socket: WebSocket, state: AppState, peer_addr: SocketAddr) {
    if let Err(error) = state
        .bridge
        .handle_socket(socket, &state.token, Some(peer_addr))
        .await
    {
        tracing::warn!(%error, "websocket bridge closed with error");
    }
}

async fn require_bearer_token(
    State(expected_token): State<String>,
    req: Request<Body>,
    next: Next,
) -> Response {
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected_token);

    if authorized {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

async fn shutdown_signal(token: CancellationToken) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => tracing::info!("shutdown signal received"),
        Err(error) => tracing::error!(%error, "failed to install shutdown signal handler"),
    }
    token.cancel();
}
