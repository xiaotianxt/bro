use std::{net::SocketAddr, time::Duration};

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

use crate::{
    bridge::{BrowserBridge, Heartbeat},
    mcp,
};

const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(5);
// Pinging more often than every 30s also keeps the MV3 service worker from being
// suspended mid-session; three missed probes is long enough to ride out a busy
// event loop without leaving a dead session that keeps taking calls.
const HEARTBEAT: Heartbeat = Heartbeat {
    interval: Duration::from_secs(15),
    timeout: Duration::from_secs(45),
};

pub struct ServerConfig {
    pub bind: SocketAddr,
    pub token: String,
    pub bridge: BrowserBridge,
}

#[derive(Clone)]
struct AppState {
    bridge: BrowserBridge,
    token: String,
    authentication_timeout: Duration,
    heartbeat: Heartbeat,
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
        authentication_timeout: AUTHENTICATION_TIMEOUT,
        heartbeat: HEARTBEAT,
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
        .handle_socket(
            socket,
            &state.token,
            Some(peer_addr),
            state.authentication_timeout,
            state.heartbeat,
        )
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

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, time::Duration};

    use axum::{routing::get, Router};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::{net::TcpListener, task::JoinHandle};
    use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

    use super::{ws, AppState};
    use crate::bridge::{BrowserBridge, Heartbeat};

    type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    const FAST_HEARTBEAT: Heartbeat = Heartbeat {
        interval: Duration::from_millis(20),
        timeout: Duration::from_millis(80),
    };

    async fn spawn_server(
        bridge: &BrowserBridge,
        authentication_timeout: Duration,
        heartbeat: Heartbeat,
    ) -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/ws", get(ws)).with_state(AppState {
            bridge: bridge.clone(),
            token: "secret".to_string(),
            authentication_timeout,
            heartbeat,
        });
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (address, server)
    }

    async fn next_text(socket: &mut TestSocket) -> serde_json::Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(1), socket.next())
                .await
                .expect("server sent nothing")
                .expect("websocket ended")
                .expect("websocket failed");
            if let Message::Text(text) = frame {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }

    /// Connects and authenticates like the extension, consuming `connected`.
    async fn connect_extension(address: SocketAddr) -> TestSocket {
        let (mut socket, _response) = connect_async(format!("ws://{address}/ws")).await.unwrap();
        let connect = json!({
            "type": "connect",
            "version": "1.4.1",
            "extensionId": "extension",
            "instanceId": "a",
            "token": "secret",
            "activeTabUrl": null,
            "browserInfo": null,
        });
        socket
            .send(Message::Text(connect.to_string().into()))
            .await
            .unwrap();
        assert_eq!(next_text(&mut socket).await["type"], "connected");
        socket
    }

    #[tokio::test]
    async fn silent_extension_connection_is_dropped_and_fails_its_pending_call() {
        let bridge = BrowserBridge::new();
        let (address, server) = spawn_server(&bridge, Duration::from_secs(1), FAST_HEARTBEAT).await;
        let mut socket = connect_extension(address).await;
        assert_eq!(bridge.extension_count(), 1);

        let call = {
            let bridge = bridge.clone();
            tokio::spawn(
                async move { bridge.dispatch("tabs_context", json!({}), None, None).await },
            )
        };
        // The extension never answers the call or the pings, like a socket whose
        // peer stopped processing without closing.
        let result = tokio::time::timeout(Duration::from_secs(2), call)
            .await
            .expect("pending call waited for the tool timeout instead of the heartbeat")
            .unwrap()
            .unwrap();
        assert!(result.is_error);
        assert_eq!(result.result["message"], "browser extension disconnected");
        assert_eq!(bridge.extension_count(), 0);

        // Dropping the session must also end the socket so the extension reconnects.
        let ended = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match socket.next().await {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "server kept the dead socket open");
        server.abort();
    }

    #[tokio::test]
    async fn extension_answering_pings_stays_connected_past_the_timeout() {
        let bridge = BrowserBridge::new();
        let (address, server) = spawn_server(&bridge, Duration::from_secs(1), FAST_HEARTBEAT).await;
        let mut socket = connect_extension(address).await;

        let deadline = tokio::time::Instant::now() + FAST_HEARTBEAT.timeout * 4;
        let mut pings = 0;
        while tokio::time::Instant::now() < deadline {
            let message = next_text(&mut socket).await;
            assert_eq!(message["type"], "ping");
            pings += 1;
            socket
                .send(Message::Text(json!({"type": "pong"}).to_string().into()))
                .await
                .unwrap();
        }
        assert!(pings >= 4, "expected periodic pings, got {pings}");
        assert_eq!(bridge.extension_count(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn websocket_without_authentication_frame_gets_policy_close() {
        let bridge = BrowserBridge::new();
        let (address, server) =
            spawn_server(&bridge, Duration::from_millis(20), FAST_HEARTBEAT).await;
        let (mut socket, _response) = connect_async(format!("ws://{address}/ws")).await.unwrap();

        assert_eq!(bridge.extension_count(), 0);
        let frame = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("server did not enforce the authentication timeout")
            .expect("websocket ended without a close frame")
            .expect("websocket failed before receiving the close frame");

        match frame {
            Message::Close(Some(close)) => assert_eq!(u16::from(close.code), 1008),
            other => panic!("expected policy close, got {other:?}"),
        }
        assert_eq!(bridge.extension_count(), 0);
        server.abort();
    }
}
