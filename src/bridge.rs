use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{self, Duration};
use uuid::Uuid;

use crate::native::{inspect_browser_connection, NativeBrowserInfo};
use crate::protocol::{
    AgentDoneMessage, ConnectMessage, ConnectedMessage, ExtensionStatus, ExtensionToServer,
    ServerToExtension, StatusResponse, ToolCallMessage,
};

const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("no browser extension is connected")]
    NoBrowser,
    #[error("unknown browser id: {0}")]
    UnknownBrowser(String),
    #[error("browser extension disconnected")]
    BrowserDisconnected,
    #[error("tool call timed out")]
    ToolTimeout,
    #[error("websocket error: {0}")]
    WebSocket(#[from] axum::Error),
    #[error("protocol serialization error: {0}")]
    Protocol(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BridgeToolResult {
    pub result: Value,
    pub is_error: bool,
}

#[derive(Clone, Default)]
pub struct BrowserBridge {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: RwLock<BridgeState>,
    pending: Mutex<HashMap<String, PendingCall>>,
}

#[derive(Default)]
struct BridgeState {
    browsers: HashMap<String, BrowserConnection>,
    latest_browser_id: Option<String>,
    sequence: u64,
}

struct BrowserConnection {
    extension_id: String,
    session_id: String,
    active_tab_url: Option<String>,
    browser_info: Option<crate::protocol::BrowserInfo>,
    native_info: Option<NativeBrowserInfo>,
    last_seen_unix_ms: i64,
    sequence: u64,
    sender: mpsc::UnboundedSender<ServerToExtension>,
}

struct PendingCall {
    browser_id: String,
    tx: oneshot::Sender<Result<BridgeToolResult, BridgeError>>,
}

impl BrowserBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn extension_count(&self) -> usize {
        read_state(&self.inner.state).browsers.len()
    }

    pub fn status(&self) -> StatusResponse {
        let state = read_state(&self.inner.state);
        let mut extensions = state
            .browsers
            .iter()
            .map(|(browser_id, browser)| ExtensionStatus {
                browser_id: browser_id.clone(),
                extension_id: browser.extension_id.clone(),
                session_id: browser.session_id.clone(),
                active_tab_url: browser.active_tab_url.clone(),
                browser_info: browser.browser_info.clone(),
                native_info: browser.native_info.clone(),
                last_seen_unix_ms: browser.last_seen_unix_ms,
            })
            .collect::<Vec<_>>();
        extensions.sort_by(|a, b| a.browser_id.cmp(&b.browser_id));

        StatusResponse {
            extension_count: extensions.len(),
            default_browser_id: state.latest_browser_id.clone(),
            extensions,
        }
    }

    pub async fn dispatch(
        &self,
        tool_name: impl Into<String>,
        args: Value,
        tab_id: Option<i64>,
        browser_id: Option<String>,
    ) -> Result<BridgeToolResult, BridgeError> {
        let target = self.resolve_browser(browser_id).await?;
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        self.inner.pending.lock().await.insert(
            request_id.clone(),
            PendingCall {
                browser_id: target.browser_id.clone(),
                tx,
            },
        );

        let message = ServerToExtension::ToolCall(ToolCallMessage {
            request_id: request_id.clone(),
            tool: tool_name.into(),
            args,
            tab_id,
        });

        if target.sender.send(message).is_err() {
            self.remove_pending(&request_id).await;
            return Err(BridgeError::BrowserDisconnected);
        }

        match time::timeout(TOOL_CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_closed)) => Err(BridgeError::BrowserDisconnected),
            Err(_elapsed) => {
                self.remove_pending(&request_id).await;
                Ok(error_tool_result("tool call timed out"))
            }
        }
    }

    pub async fn agent_done(
        &self,
        tab_ids: Vec<i64>,
        browser_id: Option<String>,
    ) -> Result<(), BridgeError> {
        let target = self.resolve_browser(browser_id).await?;
        target
            .sender
            .send(ServerToExtension::AgentDone(AgentDoneMessage { tab_ids }))
            .map_err(|_err| BridgeError::BrowserDisconnected)
    }

    /// Send reload command to all connected extensions.
    pub fn reload_all_extensions(&self) -> usize {
        let state = read_state(&self.inner.state);
        let mut sent = 0;
        for browser in state.browsers.values() {
            if browser
                .sender
                .send(ServerToExtension::ReloadExtension)
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    pub async fn handle_socket(
        &self,
        mut socket: WebSocket,
        expected_token: &str,
        peer_addr: Option<SocketAddr>,
    ) -> Result<(), BridgeError> {
        let connect = match socket.recv().await {
            Some(Ok(Message::Text(text))) => match ExtensionToServer::parse_json(text.as_str()) {
                Ok(ExtensionToServer::Connect(connect)) if connect.token == expected_token => {
                    connect
                }
                _ => {
                    close_policy_violation(&mut socket).await?;
                    return Ok(());
                }
            },
            Some(Ok(_)) | None => {
                close_policy_violation(&mut socket).await?;
                return Ok(());
            }
            Some(Err(err)) => return Err(BridgeError::WebSocket(err)),
        };

        let browser_id = connect.instance_id.clone();
        let session_id = Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::unbounded_channel::<ServerToExtension>();

        let (mut ws_tx, mut ws_rx) = socket.split();
        tx.send(ServerToExtension::Connected(ConnectedMessage {
            session_id: session_id.clone(),
        }))
        .map_err(|_err| BridgeError::BrowserDisconnected)?;

        let native_info = inspect_browser_connection(peer_addr);
        self.register_browser(connect, session_id, tx, Some(native_info));

        let writer = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let json = message.to_json()?;
                ws_tx.send(Message::Text(json.into())).await?;
            }
            Ok::<(), BridgeError>(())
        });

        while let Some(frame) = ws_rx.next().await {
            match frame? {
                Message::Text(text) => {
                    self.handle_authenticated_message(&browser_id, text.as_str())
                        .await;
                }
                Message::Close(_close) => break,
                Message::Ping(bytes) => {
                    let _ignored = bytes;
                    self.touch_browser(&browser_id);
                }
                Message::Pong(_bytes) => {
                    self.touch_browser(&browser_id);
                }
                Message::Binary(_bytes) => {}
            }
        }

        self.unregister_browser(&browser_id).await;
        writer.abort();
        Ok(())
    }

    async fn resolve_browser(
        &self,
        browser_id: Option<String>,
    ) -> Result<ResolvedBrowser, BridgeError> {
        let state = read_state(&self.inner.state);
        let selected = match browser_id {
            Some(id) => id,
            None => state
                .latest_browser_id
                .clone()
                .ok_or(BridgeError::NoBrowser)?,
        };

        let browser = state
            .browsers
            .get(&selected)
            .ok_or_else(|| BridgeError::UnknownBrowser(selected.clone()))?;

        Ok(ResolvedBrowser {
            browser_id: selected,
            sender: browser.sender.clone(),
        })
    }

    fn register_browser(
        &self,
        connect: ConnectMessage,
        session_id: String,
        sender: mpsc::UnboundedSender<ServerToExtension>,
        native_info: Option<NativeBrowserInfo>,
    ) {
        let mut state = write_state(&self.inner.state);
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        let browser_id = connect.instance_id;
        state.latest_browser_id = Some(browser_id.clone());
        state.browsers.insert(
            browser_id,
            BrowserConnection {
                extension_id: connect.extension_id,
                session_id,
                active_tab_url: connect.active_tab_url,
                browser_info: connect.browser_info,
                native_info,
                last_seen_unix_ms: now_unix_ms(),
                sequence,
                sender,
            },
        );
    }

    async fn unregister_browser(&self, browser_id: &str) {
        {
            let mut state = write_state(&self.inner.state);
            state.browsers.remove(browser_id);
            if state.latest_browser_id.as_deref() == Some(browser_id) {
                state.latest_browser_id = state
                    .browsers
                    .iter()
                    .max_by_key(|(_id, browser)| browser.sequence)
                    .map(|(id, _browser)| id.clone());
            }
        }

        let mut pending = self.inner.pending.lock().await;
        let pending_ids = pending
            .iter()
            .filter(|(_request_id, call)| call.browser_id == browser_id)
            .map(|(request_id, _call)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in pending_ids {
            if let Some(call) = pending.remove(&request_id) {
                let _ignored = call
                    .tx
                    .send(Ok(error_tool_result("browser extension disconnected")));
            }
        }
    }

    async fn handle_authenticated_message(&self, browser_id: &str, text: &str) {
        match ExtensionToServer::parse_json(text) {
            Ok(ExtensionToServer::ToolResult(message)) => {
                self.complete_pending(
                    &message.request_id,
                    Ok(BridgeToolResult {
                        result: message.result,
                        is_error: false,
                    }),
                )
                .await;
                self.touch_browser(browser_id);
            }
            Ok(ExtensionToServer::ToolError(message)) => {
                self.complete_pending(
                    &message.request_id,
                    Ok(BridgeToolResult {
                        result: serde_json::json!({ "message": message.error.message }),
                        is_error: true,
                    }),
                )
                .await;
                self.touch_browser(browser_id);
            }
            Ok(ExtensionToServer::Pong(_pong)) => {
                self.touch_browser(browser_id);
            }
            Ok(ExtensionToServer::Connect(_)) | Err(_) => {}
        }
    }

    async fn complete_pending(
        &self,
        request_id: &str,
        result: Result<BridgeToolResult, BridgeError>,
    ) {
        if let Some(call) = self.inner.pending.lock().await.remove(request_id) {
            let _ignored = call.tx.send(result);
        }
    }

    async fn remove_pending(&self, request_id: &str) {
        self.inner.pending.lock().await.remove(request_id);
    }

    fn touch_browser(&self, browser_id: &str) {
        if let Some(browser) = write_state(&self.inner.state).browsers.get_mut(browser_id) {
            browser.last_seen_unix_ms = now_unix_ms();
        }
    }
}

fn read_state(lock: &RwLock<BridgeState>) -> RwLockReadGuard<'_, BridgeState> {
    match lock.read() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn write_state(lock: &RwLock<BridgeState>) -> RwLockWriteGuard<'_, BridgeState> {
    match lock.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

struct ResolvedBrowser {
    browser_id: String,
    sender: mpsc::UnboundedSender<ServerToExtension>,
}

fn error_tool_result(message: &str) -> BridgeToolResult {
    BridgeToolResult {
        result: serde_json::json!({ "message": message }),
        is_error: true,
    }
}

async fn close_policy_violation(socket: &mut WebSocket) -> Result<(), BridgeError> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "authentication failed".into(),
        })))
        .await?;
    Ok(())
}

fn now_unix_ms() -> i64 {
    let now = std::time::SystemTime::now();
    match now.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().try_into().unwrap_or(i64::MAX),
        Err(_err) => 0,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{BridgeError, BrowserBridge};

    #[tokio::test]
    async fn dispatch_without_browser_returns_no_browser_error() {
        let bridge = BrowserBridge::new();

        let err = bridge
            .dispatch("get_page_text", json!({}), None, None)
            .await
            .unwrap_err();

        assert!(matches!(err, BridgeError::NoBrowser));
        assert_eq!(bridge.extension_count(), 0);

        let status = bridge.status();
        assert_eq!(status.extension_count, 0);
        assert_eq!(status.default_browser_id, None);
        assert!(status.extensions.is_empty());
    }
}
