use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
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
    #[error("request cancelled; already-dispatched effects are not undone")]
    Cancelled,
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
    pending: std::sync::Mutex<HashMap<String, PendingCall>>,
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
    session_id: String,
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

    /// Capture both selection and authenticated connection before acquisition.
    pub async fn bind(&self, browser_id: Option<String>) -> Result<BrowserTarget, BridgeError> {
        let target = self.resolve_browser(browser_id).await?;
        Ok(BrowserTarget {
            browser_id: target.browser_id,
            session_id: target.session_id,
        })
    }

    pub async fn dispatch(
        &self,
        tool_name: impl Into<String>,
        args: Value,
        tab_id: Option<i64>,
        browser_id: Option<String>,
    ) -> Result<BridgeToolResult, BridgeError> {
        self.dispatch_bound(tool_name, args, tab_id, browser_id, None)
            .await
    }

    /// Pin operations to the same authenticated extension connection.
    pub async fn dispatch_bound(
        &self,
        tool_name: impl Into<String>,
        args: Value,
        tab_id: Option<i64>,
        browser_id: Option<String>,
        expected_session: Option<&str>,
    ) -> Result<BridgeToolResult, BridgeError> {
        let target = self.resolve_browser(browser_id).await?;
        if expected_session.is_some_and(|session| session != target.session_id) {
            return Err(BridgeError::BrowserDisconnected);
        }
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        self.inner
            .pending
            .lock()
            .expect("pending lock poisoned")
            .insert(
                request_id.clone(),
                PendingCall {
                    browser_id: target.browser_id.clone(),
                    session_id: target.session_id.clone(),
                    tx,
                },
            );

        // Synchronous removal on drop also covers an outer timeout/abort.
        let _registration = PendingRegistration {
            inner: &self.inner,
            request_id: &request_id,
        };
        let message = ServerToExtension::ToolCall(ToolCallMessage {
            request_id: request_id.clone(),
            tool: tool_name.into(),
            args,
            tab_id,
        });

        if target.sender.send(message).is_err() {
            return Err(BridgeError::BrowserDisconnected);
        }

        match time::timeout(TOOL_CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_closed)) => Err(BridgeError::BrowserDisconnected),
            Err(_elapsed) => Ok(error_tool_result("tool call timed out")),
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
        authentication_timeout: Duration,
    ) -> Result<(), BridgeError> {
        let first_frame = match time::timeout(authentication_timeout, socket.recv()).await {
            Ok(frame) => frame,
            Err(_elapsed) => {
                close_policy_violation(&mut socket, "authentication timed out").await?;
                return Ok(());
            }
        };
        let connect = match first_frame {
            Some(Ok(Message::Text(text))) => match ExtensionToServer::parse_json(text.as_str()) {
                Ok(ExtensionToServer::Connect(connect)) if connect.token == expected_token => {
                    connect
                }
                _ => {
                    close_policy_violation(&mut socket, "authentication failed").await?;
                    return Ok(());
                }
            },
            Some(Ok(_)) | None => {
                close_policy_violation(&mut socket, "authentication failed").await?;
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
        self.register_browser(connect, session_id.clone(), tx, Some(native_info));

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
                    self.handle_authenticated_message(&browser_id, &session_id, text.as_str())
                        .await;
                }
                Message::Close(_close) => break,
                Message::Ping(bytes) => {
                    let _ignored = bytes;
                    self.touch_browser(&browser_id, &session_id);
                }
                Message::Pong(_bytes) => {
                    self.touch_browser(&browser_id, &session_id);
                }
                Message::Binary(_bytes) => {}
            }
        }

        self.unregister_browser(&browser_id, &session_id).await;
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
            session_id: browser.session_id.clone(),
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

    async fn unregister_browser(&self, browser_id: &str, session_id: &str) {
        {
            let mut state = write_state(&self.inner.state);
            let is_current = state
                .browsers
                .get(browser_id)
                .is_some_and(|browser| browser.session_id == session_id);
            if is_current {
                state.browsers.remove(browser_id);
                if state.latest_browser_id.as_deref() == Some(browser_id) {
                    state.latest_browser_id = state
                        .browsers
                        .iter()
                        .max_by_key(|(_id, browser)| browser.sequence)
                        .map(|(id, _browser)| id.clone());
                }
            }
        }

        let mut pending = self.inner.pending.lock().expect("pending lock poisoned");
        let pending_ids = pending
            .iter()
            .filter(|(_request_id, call)| {
                call.browser_id == browser_id && call.session_id == session_id
            })
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

    async fn handle_authenticated_message(&self, browser_id: &str, session_id: &str, text: &str) {
        match ExtensionToServer::parse_json(text) {
            Ok(ExtensionToServer::ToolResult(message)) => {
                self.complete_pending(
                    &message.request_id,
                    browser_id,
                    session_id,
                    Ok(BridgeToolResult {
                        is_error: embedded_tool_error(&message.result),
                        result: message.result,
                    }),
                )
                .await;
                self.touch_browser(browser_id, session_id);
            }
            Ok(ExtensionToServer::ToolError(message)) => {
                self.complete_pending(
                    &message.request_id,
                    browser_id,
                    session_id,
                    Ok(BridgeToolResult {
                        result: serde_json::json!({ "message": message.error.message }),
                        is_error: true,
                    }),
                )
                .await;
                self.touch_browser(browser_id, session_id);
            }
            Ok(ExtensionToServer::Pong(_pong)) => {
                self.touch_browser(browser_id, session_id);
            }
            Ok(ExtensionToServer::Connect(_)) | Err(_) => {}
        }
    }

    async fn complete_pending(
        &self,
        request_id: &str,
        browser_id: &str,
        session_id: &str,
        result: Result<BridgeToolResult, BridgeError>,
    ) {
        let mut pending = self.inner.pending.lock().expect("pending lock poisoned");
        if !pending
            .get(request_id)
            .is_some_and(|call| call.browser_id == browser_id && call.session_id == session_id)
        {
            return;
        }
        if let Some(call) = pending.remove(request_id) {
            let _ignored = call.tx.send(result);
        }
    }

    fn touch_browser(&self, browser_id: &str, session_id: &str) {
        if let Some(browser) = write_state(&self.inner.state)
            .browsers
            .get_mut(browser_id)
            .filter(|browser| browser.session_id == session_id)
        {
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

/// Authority for dependent work and cleanup; never rebind after reconnect.
#[derive(Debug, Clone)]
pub struct BrowserTarget {
    pub browser_id: String,
    session_id: String,
}

impl BrowserTarget {
    pub async fn dispatch(
        &self,
        bridge: &BrowserBridge,
        tool: impl Into<String>,
        args: Value,
        tab_id: Option<i64>,
    ) -> Result<BridgeToolResult, BridgeError> {
        bridge
            .dispatch_bound(
                tool,
                args,
                tab_id,
                Some(self.browser_id.clone()),
                Some(&self.session_id),
            )
            .await
    }
}

struct PendingRegistration<'a> {
    inner: &'a Inner,
    request_id: &'a str,
}

impl Drop for PendingRegistration<'_> {
    fn drop(&mut self) {
        self.inner
            .pending
            .lock()
            .expect("pending lock poisoned")
            .remove(self.request_id);
    }
}

struct ResolvedBrowser {
    browser_id: String,
    session_id: String,
    sender: mpsc::UnboundedSender<ServerToExtension>,
}

fn embedded_tool_error(result: &Value) -> bool {
    result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn error_tool_result(message: &str) -> BridgeToolResult {
    BridgeToolResult {
        result: serde_json::json!({ "message": message }),
        is_error: true,
    }
}

async fn close_policy_violation(
    socket: &mut WebSocket,
    reason: &'static str,
) -> Result<(), BridgeError> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: reason.into(),
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
    use tokio::sync::mpsc;

    use serde_json::json;

    use crate::protocol::ConnectMessage;

    use super::{embedded_tool_error, BridgeError, BrowserBridge};

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

    #[tokio::test]
    async fn replies_must_match_both_browser_and_connection_before_consuming_pending_call() {
        let bridge = BrowserBridge::new();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        bridge
            .inner
            .pending
            .lock()
            .expect("pending lock poisoned")
            .insert(
                "request".into(),
                super::PendingCall {
                    browser_id: "browser".into(),
                    session_id: "session".into(),
                    tx,
                },
            );
        let result = || {
            Ok(super::BridgeToolResult {
                result: json!({"status":"ready"}),
                is_error: false,
            })
        };
        bridge
            .complete_pending("request", "other", "session", result())
            .await;
        bridge
            .complete_pending("request", "browser", "old-session", result())
            .await;
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        bridge
            .complete_pending("request", "browser", "session", result())
            .await;
        assert!(rx.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn facade_targets_stay_pinned_and_composed_observations_fail_fast() {
        use crate::{facade::BrowserFacade, protocol::ServerToExtension};
        let bridge = BrowserBridge::new();
        let connect = |id: &str| ConnectMessage {
            version: "1.4.0".into(),
            extension_id: "extension".into(),
            instance_id: id.into(),
            token: "test".into(),
            active_tab_url: None,
            browser_info: None,
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        bridge.register_browser(connect("a"), "connection-a".into(), sender, None);
        let facade = BrowserFacade::new(bridge.clone());
        let opening = {
            let facade = facade.clone();
            tokio::spawn(async move {
                facade.open(json!({"url":"https://start.test", "ownerSessionId":"pi-owner", "label":"Task"}).as_object().unwrap().clone()).await.unwrap()
            })
        };
        let ServerToExtension::ToolCall(create) = receiver.recv().await.unwrap() else {
            panic!("expected create")
        };
        assert_eq!(create.tool, "tabs_create");
        assert_eq!(create.args["sessionId"], "pi-owner");
        assert_eq!(create.args["deferReadiness"], true);
        bridge
            .complete_pending(
                &create.request_id,
                "a",
                "connection-a",
                Ok(super::BridgeToolResult {
                    result: json!({"content":[{"type":"text","text":"Created tab: 42"}]}),
                    is_error: false,
                }),
            )
            .await;
        let opened = opening.await.unwrap();
        // Model-facing envelopes carry the target handle, not connection identity.
        assert_eq!(
            opened.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["tabId", "targetId", "url"]
        );
        let target = opened["targetId"].as_str().unwrap().to_string();
        let (other_sender, mut other_receiver) = mpsc::unbounded_channel();
        bridge.register_browser(connect("b"), "connection-b".into(), other_sender, None);
        assert_eq!(bridge.status().default_browser_id.as_deref(), Some("b"));

        // Parsing every step precedes any effect, including the shared observe options.
        assert!(facade.act(json!({"targetId":target,"steps":[{"type":"navigate","url":"https://next.test"},{"type":"observe","mode":"text","refId":"r"}]}).as_object().unwrap().clone()).await.is_err());
        assert!(receiver.try_recv().is_err());
        let acting = {
            let facade = facade.clone();
            let target = target.clone();
            tokio::spawn(async move {
                facade.act(json!({"targetId":target,"steps":[
                {"type":"navigate","url":"https://next.test"},
                {"type":"evaluate","code":"''"},
                {"type":"observe","refId":"scope","maxChars":900,"filter":"interactive"},
                {"type":"evaluate","code":"mustNotRun()"}
            ]}).as_object().unwrap().clone()).await.unwrap()
            })
        };
        // The open's deferred readiness settles first, on the pinned connection.
        let ServerToExtension::ToolCall(probe) = receiver.recv().await.unwrap() else {
            panic!("expected readiness probe")
        };
        assert_eq!(
            (probe.tool.as_str(), probe.tab_id),
            ("javascript_tool", Some(42))
        );
        let ready =
            json!({"loading":false,"blank":false,"text":"Readable page sentence. ".repeat(12)});
        bridge
            .complete_pending(
                &probe.request_id,
                "a",
                "connection-a",
                Ok(super::BridgeToolResult {
                    result: json!({"content":[{"type":"text","text":ready.to_string()}]}),
                    is_error: false,
                }),
            )
            .await;
        for (tool, text, failed) in [
            ("navigate", "Navigated to https://next.test", false),
            ("javascript_tool", "", false),
            ("read_page", "stale scope", true),
        ] {
            let ServerToExtension::ToolCall(call) = receiver.recv().await.unwrap() else {
                panic!("expected action")
            };
            assert_eq!(call.tool, tool);
            assert_eq!(call.tab_id, Some(42));
            if tool == "read_page" {
                assert_eq!(call.args["maxChars"], 900);
                assert_eq!(call.args["refId"], "scope");
            }
            bridge
                .complete_pending(
                    &call.request_id,
                    "a",
                    "connection-a",
                    Ok(super::BridgeToolResult {
                        result: json!({"content":[{"type":"text","text":text}]}),
                        is_error: failed,
                    }),
                )
                .await;
        }
        let result = acting.await.unwrap();
        assert_eq!(result["status"], "failed");
        assert_eq!(result["stoppedAt"], 2);
        assert_eq!(
            result["results"][0],
            json!({"type":"navigate","url":"https://next.test"})
        );
        // A legitimate empty eval is not a readiness test.
        assert_eq!(result["results"][1], json!({"type":"evaluate","result":""}));
        assert_eq!(result["results"][2]["error"], "stale scope");
        for key in ["browserId", "cleanup", "tabId", "acknowledgement"] {
            assert!(
                !result.to_string().contains(key),
                "{key} leaked into act output"
            );
        }
        let text = crate::facade::render_act(&result);
        assert!(text.starts_with("failed at step 3 (observe): stale scope\ntargetId: "));
        assert!(text.ends_with("\nnavigated: https://next.test\nevaluated: "));
        assert!(receiver.try_recv().is_err());
        assert!(other_receiver.try_recv().is_err());

        // Failed close retains ownership for retry; neither close follows the new default.
        for failed in [true, false] {
            let closing = {
                let facade = facade.clone();
                let target = target.clone();
                tokio::spawn(async move {
                    facade
                        .close(json!({"targetId":target}).as_object().unwrap().clone())
                        .await
                        .unwrap()
                })
            };
            let ServerToExtension::ToolCall(call) = receiver.recv().await.unwrap() else {
                panic!("expected close")
            };
            assert_eq!(call.tool, "tabs_close");
            assert_eq!(call.args["tabId"], 42);
            bridge
                .complete_pending(
                    &call.request_id,
                    "a",
                    "connection-a",
                    Ok(super::BridgeToolResult {
                        result: json!({"content":[{"type":"text","text":"close result"}]}),
                        is_error: failed,
                    }),
                )
                .await;
            assert_eq!(closing.await.unwrap()["closed"], !failed);
        }
        assert!(other_receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn batch_flow_records_ownership_before_readiness_and_never_evaluates_on_failure() {
        use crate::{facade::BrowserFacade, protocol::ServerToExtension};
        let bridge = BrowserBridge::new();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        bridge.register_browser(
            ConnectMessage {
                version: "1.4.0".into(),
                extension_id: "extension".into(),
                instance_id: "a".into(),
                token: "test".into(),
                active_tab_url: None,
                browser_info: None,
            },
            "connection".into(),
            sender,
            None,
        );
        let facade = BrowserFacade::new(bridge.clone());
        for timeout in [false, true] {
            let running = {
                let facade = facade.clone();
                tokio::spawn(async move {
                    facade.batch_flow(json!({"urls":["https://slow.test"],"steps":[{"type":"eval","code":"document.URL"}],"timeoutMs":if timeout { 100 } else { 12000 }}).as_object().unwrap().clone()).await.unwrap()
                })
            };
            let ServerToExtension::ToolCall(create) = receiver.recv().await.unwrap() else {
                panic!("expected create")
            };
            assert_eq!(create.tool, "tabs_create");
            assert_eq!(create.args["url"], "about:blank");
            bridge
                .complete_pending(
                    &create.request_id,
                    "a",
                    "connection",
                    Ok(super::BridgeToolResult {
                        result: json!({"content":[{"type":"text","text":"Created tab: 42"}]}),
                        is_error: false,
                    }),
                )
                .await;
            let ServerToExtension::ToolCall(navigate) = receiver.recv().await.unwrap() else {
                panic!("expected navigate")
            };
            assert_eq!(navigate.tool, "navigate");
            if !timeout {
                bridge
                    .complete_pending(
                        &navigate.request_id,
                        "a",
                        "connection",
                        Ok(super::BridgeToolResult {
                            result: json!({"content":[{"type":"text","text":"readiness unmet"}]}),
                            is_error: true,
                        }),
                    )
                    .await;
            }
            let ServerToExtension::ToolCall(close) = receiver.recv().await.unwrap() else {
                panic!("expected cleanup")
            };
            assert_eq!(close.tool, "tabs_close");
            assert_eq!(close.args["tabId"], 42);
            bridge
                .complete_pending(
                    &close.request_id,
                    "a",
                    "connection",
                    Ok(super::BridgeToolResult {
                        result: json!({"content":[{"type":"text","text":"closed"}]}),
                        is_error: false,
                    }),
                )
                .await;
            assert_eq!(running.await.unwrap()["results"][0]["status"], "failed");
            assert!(receiver.try_recv().is_err());
            // Simulate the extension's interruption reply after the owning tab closes.
            if timeout {
                bridge
                    .complete_pending(
                        &navigate.request_id,
                        "a",
                        "connection",
                        Ok(super::BridgeToolResult {
                            result: json!({}),
                            is_error: true,
                        }),
                    )
                    .await;
            }
        }
    }

    fn connect_test_browser(
        bridge: &BrowserBridge,
        connection: &str,
    ) -> mpsc::UnboundedReceiver<crate::protocol::ServerToExtension> {
        let (sender, receiver) = mpsc::unbounded_channel();
        bridge.register_browser(
            ConnectMessage {
                version: "1.4.0".into(),
                extension_id: "extension".into(),
                instance_id: "a".into(),
                token: "test".into(),
                active_tab_url: None,
                browser_info: None,
            },
            connection.into(),
            sender,
            None,
        );
        receiver
    }

    async fn next_call(
        receiver: &mut mpsc::UnboundedReceiver<crate::protocol::ServerToExtension>,
    ) -> crate::protocol::ToolCallMessage {
        // A step that fails early never sends the next call; fail, do not hang.
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
            .await
            .expect("timed out waiting for the next tool call")
            .unwrap();
        let crate::protocol::ServerToExtension::ToolCall(call) = message else {
            panic!("expected tool call")
        };
        call
    }

    async fn reply(
        bridge: &BrowserBridge,
        call: &crate::protocol::ToolCallMessage,
        connection: &str,
        text: &str,
    ) {
        bridge
            .complete_pending(
                &call.request_id,
                "a",
                connection,
                Ok(super::BridgeToolResult {
                    result: json!({"content":[{"type":"text","text":text}]}),
                    is_error: false,
                }),
            )
            .await;
    }

    async fn open_test_target(
        facade: &crate::facade::BrowserFacade,
        bridge: &BrowserBridge,
        receiver: &mut mpsc::UnboundedReceiver<crate::protocol::ServerToExtension>,
    ) -> serde_json::Value {
        // about:blank has no load to settle, so the first use goes straight
        // to the tested call.
        let facade = facade.clone();
        let opening = tokio::spawn(async move {
            facade
                .open(json!({"url":"about:blank"}).as_object().unwrap().clone())
                .await
                .unwrap()
        });
        let call = next_call(receiver).await;
        reply(bridge, &call, "first", "Created tab: 42").await;
        opening.await.unwrap()["targetId"].clone()
    }

    async fn open_test_target_value(
        facade: &crate::facade::BrowserFacade,
        bridge: &BrowserBridge,
        receiver: &mut mpsc::UnboundedReceiver<crate::protocol::ServerToExtension>,
    ) -> serde_json::Value {
        let facade = facade.clone();
        let opening = tokio::spawn(async move {
            facade
                .open(
                    json!({"url":"https://test.invalid"})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
                .unwrap()
        });
        let call = next_call(receiver).await;
        reply(bridge, &call, "first", "Created tab: 43").await;
        opening.await.unwrap()
    }

    #[tokio::test]
    async fn reconnect_rejects_target_actions_and_cleanup_without_touching_reused_tab() {
        let bridge = BrowserBridge::new();
        let mut old = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut old).await;
        let mut replacement = connect_test_browser(&bridge, "replacement");
        let acted = facade
            .act(
                json!({"targetId":target,"steps":[{"type":"evaluate","code":"document.title"}]})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .await
            .unwrap();
        assert_eq!(acted["status"], "failed");
        assert!(acted["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("disconnected"));
        for _ in 0..2 {
            let closed = facade
                .close(json!({"targetId":target}).as_object().unwrap().clone())
                .await
                .unwrap();
            assert_eq!(closed["closed"], false);
            assert_eq!(closed["status"], "failed");
        }
        assert!(replacement.try_recv().is_err());
        assert!(old.try_recv().is_err());
    }

    #[tokio::test]
    async fn act_check_step_and_slim_results_render_one_line_per_step() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let acting = {
            let facade = facade.clone();
            let target = target.clone();
            tokio::spawn(async move {
                facade
                    .act(
                        json!({"targetId":target,"steps":[
                            {"type":"click","refId":"kqx12"},
                            {"type":"check","refId":"kqx13"},
                            {"type":"check","refId":"kqx14","checked":false},
                            {"type":"click","role":"menuitem","name":"Read and write"},
                            {"type":"press","key":"Escape"},
                            {"type":"observe","refId":"kqx2"}
                        ]})
                        .as_object()
                        .unwrap()
                        .clone(),
                    )
                    .await
                    .unwrap()
            })
        };
        // Each element step is one act_element call that acts and reports
        // what visibly changed once the page settled.
        let click = next_call(&mut receiver).await;
        assert_eq!(
            (click.tool.as_str(), &click.args),
            ("act_element", &json!({"refId":"kqx12","action":"click"}))
        );
        reply(
            &bridge,
            &click,
            "first",
            r#"{"refId":"kqx12","changes":{"settledMs":420,"quiet":true,"opened":["menu \"Access\""],"controls":["kqx20 menuitem \"Read and write\""],"moreControls":"observe kqx19 for 3 more"}}"#,
        )
        .await;
        for (ref_id, checked) in [("kqx13", true), ("kqx14", false)] {
            let check = next_call(&mut receiver).await;
            assert_eq!(check.tool, "act_element");
            assert_eq!(
                check.args,
                json!({"refId":ref_id,"action":"check","checked":checked})
            );
            reply(
                &bridge,
                &check,
                "first",
                &format!(r#"{{"refId":"{ref_id}","changes":{{"settledMs":400,"quiet":true}}}}"#),
            )
            .await;
        }
        let named = next_call(&mut receiver).await;
        assert_eq!(
            named.args,
            json!({"role":"menuitem","name":"Read and write","action":"click"})
        );
        reply(
            &bridge,
            &named,
            "first",
            r#"{"refId":"kqx20","changes":{"settledMs":450,"quiet":true,"closed":["menu \"Access\""],"added":["Access: Read and write"]}}"#,
        )
        .await;
        // An untargeted press goes to the focused element and reports changes.
        let press = next_call(&mut receiver).await;
        assert_eq!(
            (press.tool.as_str(), &press.args),
            ("act_element", &json!({"action":"press","key":"Escape"}))
        );
        reply(
            &bridge,
            &press,
            "first",
            r#"{"changes":{"settledMs":410,"quiet":true,"closed":["dialog \"Permissions\""]}}"#,
        )
        .await;
        let observe = next_call(&mut receiver).await;
        assert_eq!(observe.tool, "read_page");
        // An act observation verifies one action: a small default budget.
        assert_eq!(observe.args["maxChars"], 3000);
        assert_eq!(observe.args["refId"], "kqx2");
        reply(
            &bridge,
            &observe,
            "first",
            "Frames: 1\n  [kqx13] radio \"16GB\" checked=\"true\"",
        )
        .await;
        let result = acting.await.unwrap();
        assert_eq!(result["status"], "ok");
        assert!(result.get("stoppedAt").is_none());
        let text = crate::facade::render_act(&result);
        assert_eq!(
            text,
            format!(
                "targetId: {}\n\
                 clicked kqx12 → opened menu \"Access\"; controls kqx20 menuitem \"Read and write\"; observe kqx19 for 3 more (settled 420ms)\n\
                 checked kqx13\n\
                 unchecked kqx14\n\
                 clicked kqx20 (menuitem \"Read and write\") → closed menu \"Access\"; text \"Access: Read and write\" (settled 450ms)\n\
                 pressed Escape → closed dialog \"Permissions\" (settled 410ms)\n\
                 observed:\nFrames: 1\n  [kqx13] radio \"16GB\" checked=\"true\"",
                target.as_str().unwrap()
            )
        );
        let click_only = crate::facade::render_act(
            &json!({"targetId":target,"status":"ok","results":[{"type":"click","refId":"kqx12"}]}),
        );
        assert!(click_only.len() < 60, "{click_only}");

        // Standalone observation defaults to a bounded page budget and forwards cursor.
        let observing = {
            let facade = facade.clone();
            let target = target.clone();
            tokio::spawn(async move {
                facade
                    .observe_target(
                        json!({"targetId":target,"cursor":40})
                            .as_object()
                            .unwrap()
                            .clone(),
                    )
                    .await
                    .unwrap()
            })
        };
        let observe = next_call(&mut receiver).await;
        assert_eq!(observe.args["maxChars"], 8000);
        assert_eq!(observe.args["cursor"], 40);
        reply(&bridge, &observe, "first", "Frames: 1; from cursor=40").await;
        let observed = observing.await.unwrap();
        assert_eq!(
            crate::facade::render_observe(&observed),
            "Frames: 1; from cursor=40"
        );
        assert_eq!(
            observed.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["content", "targetId"]
        );
    }

    async fn reply_error(
        bridge: &BrowserBridge,
        call: &crate::protocol::ToolCallMessage,
        connection: &str,
        message: &str,
    ) {
        bridge
            .complete_pending(
                &call.request_id,
                "a",
                connection,
                Ok(super::BridgeToolResult {
                    result: json!({ "message": message }),
                    is_error: true,
                }),
            )
            .await;
    }

    fn spawn_act(
        facade: &crate::facade::BrowserFacade,
        args: serde_json::Value,
    ) -> tokio::task::JoinHandle<serde_json::Value> {
        let facade = facade.clone();
        tokio::spawn(async move { facade.act(args.as_object().unwrap().clone()).await.unwrap() })
    }

    #[tokio::test]
    async fn act_observe_falls_back_to_the_page_when_its_scope_was_replaced() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[
                {"type":"check","refId":"svs286"},
                {"type":"observe","refId":"svs282","filter":"interactive","cursor":40}
            ]}),
        );
        let check = next_call(&mut receiver).await;
        reply(
            &bridge,
            &check,
            "first",
            r#"{"refId":"svs286","changes":{"settledMs":400,"quiet":true}}"#,
        )
        .await;
        let scoped = next_call(&mut receiver).await;
        assert_eq!(scoped.args["refId"], "svs282");
        reply_error(
            &bridge,
            &scoped,
            "first",
            "Scoped ref svs282 no longer has an accessibility node; read a fresh snapshot",
        )
        .await;
        // Same budget and filter; the scope and its cursor do not carry over.
        let page = next_call(&mut receiver).await;
        assert_eq!(page.tool, "read_page");
        assert_eq!(
            page.args,
            json!({"filter":"interactive","depth":20,"maxChars":3000,"compact":true})
        );
        reply(
            &bridge,
            &page,
            "first",
            "Frames: 1\n  [svs300] radio \"32GB\"",
        )
        .await;
        let result = acting.await.unwrap();
        assert_eq!(result["status"], "ok");
        assert_eq!(
            crate::facade::render_act(&result),
            format!(
                "targetId: {}\nchecked svs286\nobserved:\nscope svs282 was replaced; observed page\nFrames: 1\n  [svs300] radio \"32GB\"",
                target.as_str().unwrap()
            )
        );

        // Other observation failures still stop the act.
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"observe","refId":"svs282"}]}),
        );
        let scoped = next_call(&mut receiver).await;
        reply_error(
            &bridge,
            &scoped,
            "first",
            "Document navigated or frame disappeared during observation; read a fresh snapshot.",
        )
        .await;
        let result = acting.await.unwrap();
        assert_eq!(result["stoppedAt"], 0);
    }

    #[tokio::test]
    async fn text_observation_accepts_budget_and_cursor_but_not_a11y_options() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"observe","mode":"text","maxChars":2000,"cursor":2000}]}),
        );
        let read = next_call(&mut receiver).await;
        assert_eq!(
            (read.tool.as_str(), &read.args),
            ("get_page_text", &json!({"maxChars":2000,"cursor":2000}))
        );
        reply(&bridge, &read, "first", "tail").await;
        assert_eq!(acting.await.unwrap()["results"][0]["content"], "tail");

        let rejected = facade
            .act(
                json!({"targetId":target,"steps":[{"type":"observe","mode":"text","filter":"interactive"}]})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            rejected.contains("refId/filter/depth/compact require mode a11y"),
            "{rejected}"
        );
    }

    #[tokio::test]
    async fn observation_budgets_have_facade_ceilings() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let observe = |args: serde_json::Value| {
            let facade = facade.clone();
            tokio::spawn(async move {
                facade
                    .observe_target(args.as_object().unwrap().clone())
                    .await
            })
        };

        // a11y above its cap is reduced to the cap; the footer names it.
        let reading = observe(json!({"targetId":target,"maxChars":20000}));
        let read = next_call(&mut receiver).await;
        assert_eq!(read.tool, "read_page");
        assert_eq!(read.args["maxChars"], 12000);
        reply(&bridge, &read, "first", "Frames: 1").await;
        reading.await.unwrap().unwrap();

        // Text reads content up to the full ceiling.
        let reading = observe(json!({"targetId":target,"mode":"text","maxChars":20000}));
        let read = next_call(&mut receiver).await;
        assert_eq!(
            (read.tool.as_str(), &read.args),
            ("get_page_text", &json!({"maxChars":20000}))
        );
        reply(
            &bridge,
            &read,
            "first",
            &"Readable page sentence. ".repeat(12),
        )
        .await;
        reading.await.unwrap().unwrap();

        // The act observe step gets the same cap.
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"observe","maxChars":16000}]}),
        );
        let read = next_call(&mut receiver).await;
        assert_eq!(read.args["maxChars"], 12000);
        reply(&bridge, &read, "first", "Frames: 1").await;
        acting.await.unwrap();

        // Above the ceiling is rejected before any browser call, in every facade path.
        let over = observe(json!({"targetId":target,"mode":"text","maxChars":20001}))
            .await
            .unwrap()
            .unwrap_err()
            .to_string();
        assert!(over.contains("maxChars is at most 20000"), "{over}");
        for rejected in [
            facade
                .act(
                    json!({"targetId":target,"steps":[{"type":"observe","maxChars":60000}]})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await,
            facade
                .batch_flow(
                    json!({"urls":["https://a.invalid"],"steps":[{"type":"observe","maxChars":30000}]})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await,
        ] {
            let error = rejected.unwrap_err().to_string();
            assert!(error.contains("maxChars is at most 20000"), "{error}");
        }
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn act_wait_polls_its_condition_and_reports_a_timeout_without_failing() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;

        // Met on the second poll: returns then, not at the timeout.
        let started = tokio::time::Instant::now();
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"wait","text":"Results  READY"}]}),
        );
        let first = next_call(&mut receiver).await;
        assert_eq!(first.tool, "javascript_tool");
        let code = first.args["code"].as_str().unwrap();
        assert!(
            code.contains("innerText") && code.contains(r#""Results  READY""#),
            "{code}"
        );
        reply(&bridge, &first, "first", "false").await;
        let second = next_call(&mut receiver).await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(250));
        reply(&bridge, &second, "first", "true").await;
        let value = acting.await.unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(1000));
        let wait = &value["results"][0];
        assert_eq!(wait["met"], true);
        assert_eq!(wait["condition"], r#"text "Results  READY" appears"#);
        assert!(
            crate::facade::render_act(&value).contains(r#"waited "#)
                && crate::facade::render_act(&value)
                    .contains(r#"ms until text "Results  READY" appears"#)
        );

        // A ref that left the document is hidden; a timeout is a result and
        // the following observe still runs.
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[
                {"type":"wait","refId":"abc7","state":"hidden"},
                {"type":"wait","textGone":"Loading","timeoutMs":300},
                {"type":"observe","mode":"text"}
            ]}),
        );
        let info = next_call(&mut receiver).await;
        assert_eq!(info.tool, "get_element_info");
        assert_eq!(info.args, json!({"refId":"abc7"}));
        reply_error(
            &bridge,
            &info,
            "first",
            "Stale ref abc7: its node or document disappeared.",
        )
        .await;
        loop {
            let call = next_call(&mut receiver).await;
            if call.tool == "get_page_text" {
                reply(
                    &bridge,
                    &call,
                    "first",
                    &"Readable page sentence. ".repeat(12),
                )
                .await;
                break;
            }
            assert_eq!(call.tool, "javascript_tool");
            reply_error(&bridge, &call, "first", "Cannot find context").await;
        }
        let value = acting.await.unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["results"][0]["met"], true);
        assert_eq!(value["results"][1]["met"], false);
        assert!(value["results"][1]["ms"].as_u64().unwrap() >= 300);
        let rendered = crate::facade::render_act(&value);
        assert!(
            rendered.contains("ms until abc7 is hidden\nwait not met after ")
                && rendered.contains("ms: text \"Loading\" is gone (last check failed: Cannot find context); continuing\nobserved:"),
            "{rendered}"
        );

        // A visible/enabled wait on a gone ref can never hold: it fails.
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"wait","refId":"abc7","state":"visible"}]}),
        );
        let info = next_call(&mut receiver).await;
        reply_error(
            &bridge,
            &info,
            "first",
            "Stale ref abc7: its node or document disappeared.",
        )
        .await;
        let value = acting.await.unwrap();
        assert_eq!(value["status"], "failed");

        let ready = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"wait","refId":"abc7","state":"enabled"}]}),
        );
        let info = next_call(&mut receiver).await;
        reply(
            &bridge,
            &info,
            "first",
            r#"{"visible":true,"disabled":false}"#,
        )
        .await;
        assert_eq!(ready.await.unwrap()["results"][0]["met"], true);

        for (steps, message) in [
            (
                json!([{"type":"wait","ms":500}]),
                "act wait takes a condition, not a delay",
            ),
            (json!([{"type":"wait"}]), "wait requires a condition"),
            (
                json!([{"type":"wait","text":"a","textGone":"b"}]),
                "exactly one condition",
            ),
            (
                json!([{"type":"wait","refId":"abc7"}]),
                "exactly one condition",
            ),
            (
                json!([{"type":"wait","text":"a","timeoutMs":15001}]),
                "timeoutMs must be between 1 and 15000",
            ),
            (json!([{"type":"wait","text":"a","ms":5}]), "not both"),
        ] {
            let error = facade
                .act(
                    json!({"targetId":target,"steps":steps})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(message), "{error}");
        }
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn scroll_result_names_the_element_that_actually_moved() {
        let line = |result: serde_json::Value| {
            crate::facade::render_act(&json!({"targetId":"t","status":"ok","results":[
                {"type":"scroll","refId":"abc9","result":result}
            ]}))
        };
        assert_eq!(
            line(
                json!({"refId":"abc9","scrolled":"document","delta":{"x":0,"y":400},"boundary":false})
            ),
            "targetId: t\nscrolled document (from abc9) dy=400"
        );
        assert_eq!(
            line(
                json!({"refId":"abc9","scrolled":"abc9","delta":{"x":0,"y":120.4},"boundary":true})
            ),
            "targetId: t\nscrolled abc9 dy=120; at the end"
        );
        assert_eq!(
            line(
                json!({"refId":"abc9","scrolled":"abc12 <div id=\"feed\">","delta":{"x":0,"y":0},"boundary":true})
            ),
            "targetId: t\nscrolled abc12 <div id=\"feed\"> (from abc9) without moving; at the end"
        );
    }

    #[tokio::test]
    async fn open_returns_at_dispatch_and_the_first_use_settles_readiness() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let opened = open_test_target_value(&facade, &bridge, &mut receiver).await;
        assert!(opened.get("ready").is_none() && opened.get("reason").is_none());
        let target = opened["targetId"].clone();

        // Loading, then a shell without readable text, then ready: one probe
        // per poll, and only then the observation itself.
        let started = tokio::time::Instant::now();
        let observing = {
            let facade = facade.clone();
            let target = target.clone();
            tokio::spawn(async move {
                facade
                    .observe_target(
                        json!({"targetId":target,"mode":"text"})
                            .as_object()
                            .unwrap()
                            .clone(),
                    )
                    .await
                    .unwrap()
            })
        };
        let page = "Readable page sentence. ".repeat(12);
        for probe in [
            json!({"loading":true,"blank":false,"text":""}),
            json!({"loading":false,"blank":false,"text":"Loading…"}),
            json!({"loading":false,"blank":false,"text":page}),
        ] {
            let call = next_call(&mut receiver).await;
            assert_eq!(call.tool, "javascript_tool");
            assert!(call.args["code"]
                .as_str()
                .unwrap()
                .contains("document.readyState"));
            reply(&bridge, &call, "first", &probe.to_string()).await;
        }
        let read = next_call(&mut receiver).await;
        assert_eq!(read.tool, "get_page_text");
        assert!(started.elapsed() >= std::time::Duration::from_millis(500));
        reply(&bridge, &read, "first", &page).await;
        assert_eq!(observing.await.unwrap()["content"], page);

        // Settled once: the next act goes straight to its step.
        let acting = spawn_act(
            &facade,
            json!({"targetId":target,"steps":[{"type":"evaluate","code":"1"}]}),
        );
        let eval = next_call(&mut receiver).await;
        assert_eq!(
            (eval.tool.as_str(), &eval.args["code"]),
            ("javascript_tool", &json!("1"))
        );
        reply(&bridge, &eval, "first", "1").await;
        assert_eq!(acting.await.unwrap()["status"], "ok");

        // A page that never becomes ready is capped at 4 s, then used anyway.
        tokio::time::pause();
        let slow = open_test_target_value(&facade, &bridge, &mut receiver).await;
        let acting = spawn_act(
            &facade,
            json!({"targetId":slow["targetId"],"steps":[{"type":"evaluate","code":"2"}]}),
        );
        let mut probes = 0;
        let eval = loop {
            let call = next_call(&mut receiver).await;
            if call.args["code"] == json!("2") {
                break call;
            }
            probes += 1;
            reply_error(&bridge, &call, "first", "Cannot find context").await;
        };
        assert!((15..=18).contains(&probes), "{probes}");
        reply(&bridge, &eval, "first", "2").await;
        assert_eq!(acting.await.unwrap()["status"], "ok");
    }

    #[tokio::test]
    async fn cancellation_while_first_reply_is_pending_stops_next_effect() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let cancellation = tokio_util::sync::CancellationToken::new();
        let request_facade = facade.with_cancellation(cancellation.clone());
        let acting = tokio::spawn(async move {
            request_facade.act(json!({"targetId":target,"steps":[
            {"type":"evaluate","code":"firstEffect()"}, {"type":"navigate","url":"https://must-not-run.invalid"}
        ]}).as_object().unwrap().clone()).await.unwrap()
        });
        let first = next_call(&mut receiver).await;
        cancellation.cancel();
        reply(
            &bridge,
            &first,
            "first",
            "completed already-dispatched effect",
        )
        .await;
        let result = acting.await.unwrap();
        assert_eq!(result["results"][0]["type"], "evaluate");
        assert!(result["results"][0].get("error").is_none());
        assert_eq!(result["stoppedAt"], 1);
        assert!(result["results"][1]["error"]
            .as_str()
            .unwrap()
            .contains("cancelled"));
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn empty_eval_after_mutation_is_rejected_before_any_dispatch() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let target = open_test_target(&facade, &bridge, &mut receiver).await;
        let error = facade.act(json!({"targetId":target,"steps":[
            {"type":"navigate","url":"https://must-not-run.invalid"}, {"type":"evaluate","code":""}
        ]}).as_object().unwrap().clone()).await.unwrap_err();
        assert!(error.to_string().contains("code must be nonempty"));
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn batch_acquisition_timeout_reclaims_late_tab_on_original_connection() {
        for flow in [false, true] {
            let bridge = BrowserBridge::new();
            let mut receiver = connect_test_browser(&bridge, "first");
            let facade = crate::facade::BrowserFacade::new(bridge.clone());
            let running = tokio::spawn(async move {
                let args = json!({"urls":["https://slow.invalid"],"timeoutMs":10})
                    .as_object()
                    .unwrap()
                    .clone();
                if flow {
                    let mut args = args;
                    args.insert(
                        "steps".into(),
                        json!([{"type":"eval","code":"mustNotRun()"}]),
                    );
                    facade.batch_flow(args).await.unwrap()
                } else {
                    facade.batch_run(args).await.unwrap()
                }
            });
            let create = next_call(&mut receiver).await;
            assert_eq!(create.tool, "tabs_create");
            tokio::time::advance(std::time::Duration::from_millis(11)).await;
            assert_eq!(running.await.unwrap()["results"][0]["status"], "failed");
            reply(&bridge, &create, "first", "Created tab: 42").await;
            let close = next_call(&mut receiver).await;
            assert_eq!(close.tool, "tabs_close");
            assert_eq!(close.args["tabId"], 42);
            reply(&bridge, &close, "first", "closed").await;
            tokio::task::yield_now().await;
            assert!(receiver.try_recv().is_err());
            assert!(bridge.inner.pending.lock().unwrap().is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn late_allocation_cleanup_never_closes_a_replacement_connections_tab() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let running = tokio::spawn(async move {
            facade
                .batch_run(
                    json!({"urls":["https://slow.invalid"],"timeoutMs":10})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
                .unwrap()
        });
        let create = next_call(&mut receiver).await;
        tokio::time::advance(std::time::Duration::from_millis(11)).await;
        running.await.unwrap();
        let mut replacement = connect_test_browser(&bridge, "replacement");
        reply(&bridge, &create, "first", "Created tab: 42").await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(replacement.try_recv().is_err());
        assert!(receiver.try_recv().is_err());
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_open_cleans_late_allocation_without_publishing_target() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let cancellation = tokio_util::sync::CancellationToken::new();
        let facade = crate::facade::BrowserFacade::new(bridge.clone())
            .with_cancellation(cancellation.clone());
        let opening = tokio::spawn(async move {
            facade
                .open(
                    json!({"url":"https://test.invalid"})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
        });
        let create = next_call(&mut receiver).await;
        cancellation.cancel();
        reply(&bridge, &create, "first", "Created tab: 42").await;
        let close = next_call(&mut receiver).await;
        assert_eq!(close.tool, "tabs_close");
        assert_eq!(close.args["tabId"], 42);
        reply(&bridge, &close, "first", "closed").await;
        assert!(opening
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn dropped_open_keeps_responsibility_until_late_allocation_reply() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let opening = tokio::spawn(async move {
            facade
                .open(
                    json!({"url":"https://test.invalid"})
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await
        });
        let create = next_call(&mut receiver).await;
        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        reply(&bridge, &create, "first", "Created tab: 42").await;
        let close = next_call(&mut receiver).await;
        assert_eq!(close.tool, "tabs_close");
        assert_eq!(close.args["tabId"], 42);
        reply(&bridge, &close, "first", "closed").await;
        tokio::task::yield_now().await;
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_batch_cleanup_retains_a_reported_target_for_explicit_retry() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let batch = facade.clone();
        let running = tokio::spawn(async move {
            batch.batch_flow(json!({"urls":["https://test.invalid"], "steps":[{"type":"eval","code":"document.URL"}]}).as_object().unwrap().clone()).await.unwrap()
        });
        for (tool, text) in [
            ("tabs_create", "Created tab: 42"),
            ("navigate", "ready"),
            ("javascript_tool", "evaluated"),
        ] {
            let call = next_call(&mut receiver).await;
            assert_eq!(call.tool, tool);
            reply(&bridge, &call, "first", text).await;
        }
        let close = next_call(&mut receiver).await;
        assert_eq!(close.tool, "tabs_close");
        bridge
            .complete_pending(
                &close.request_id,
                "a",
                "first",
                Ok(super::BridgeToolResult {
                    result: json!({"message":"removal denied"}),
                    is_error: true,
                }),
            )
            .await;
        let result = running.await.unwrap();
        assert_eq!(result["results"][0]["status"], "failed");
        let error = result["results"][0]["error"].as_str().unwrap();
        let target = error
            .split("targetId ")
            .nth(1)
            .unwrap()
            .split(':')
            .next()
            .unwrap()
            .to_string();
        assert!(
            receiver.try_recv().is_err(),
            "failed cleanup must not silently retry in Drop"
        );
        let closing = tokio::spawn(async move {
            facade
                .close(json!({"targetId":target}).as_object().unwrap().clone())
                .await
                .unwrap()
        });
        let retry = next_call(&mut receiver).await;
        assert_eq!(retry.tool, "tabs_close");
        reply(&bridge, &retry, "first", "closed").await;
        assert_eq!(closing.await.unwrap()["closed"], true);
    }

    #[tokio::test(start_paused = true)]
    async fn explicit_batch_cleanup_outlives_deadline_without_duplicate_close() {
        struct LogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // With a single registered dispatcher, tracing computes a callsite's
        // interest from the *registering* thread's default. A concurrent test
        // hitting the cleanup warning first would cache "never" for ours, so
        // keep a second (inert) dispatcher registered for the whole test.
        let _interest_from_all_dispatchers =
            tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
        // Exercise both batch owners, including a late error, success, reconnect,
        // and the cleanup operation's own (unchanged) timeout.
        for flow in [false, true] {
            for outcome in ["failure", "success", "replacement", "timeout"] {
                let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
                let subscriber = tracing_subscriber::fmt()
                    .without_time()
                    .with_ansi(false)
                    .with_writer({
                        let log = log.clone();
                        move || LogWriter(log.clone())
                    })
                    .finish();
                let _logging = tracing::subscriber::set_default(subscriber);
                let bridge = BrowserBridge::new();
                let mut receiver = connect_test_browser(&bridge, "first");
                let facade = crate::facade::BrowserFacade::new(bridge.clone());
                let batch = facade.clone();
                let running = tokio::spawn(async move {
                    let mut args = json!({"urls":["https://test.invalid"],"timeoutMs":10})
                        .as_object()
                        .unwrap()
                        .clone();
                    if flow {
                        args.insert(
                            "steps".into(),
                            json!([{"type":"eval","code":"document.URL"}]),
                        );
                        batch.batch_flow(args).await.unwrap()
                    } else {
                        batch.batch_run(args).await.unwrap()
                    }
                });
                for (tool, text) in [
                    ("tabs_create", "Created tab: 42"),
                    ("navigate", "ready"),
                    (if flow { "javascript_tool" } else { "get_page_text" }, "This page contains enough readable content to satisfy the normal text readiness contract. The batch must reach explicit cleanup before its deadline expires."),
                ] {
                    let call = next_call(&mut receiver).await;
                    assert_eq!(call.tool, tool);
                    reply(&bridge, &call, "first", text).await;
                }
                let close = next_call(&mut receiver).await;
                assert_eq!(close.tool, "tabs_close");
                assert_eq!(close.args["tabId"], 42);
                tokio::time::advance(std::time::Duration::from_millis(11)).await;
                let result = running.await.unwrap();
                assert_eq!(result["results"][0]["status"], "failed");
                let error = result["results"][0]["error"].as_str().unwrap();
                assert!(error.contains("operation timed out"));
                assert!(error.contains("cleanup scheduled"));
                assert!(
                    bridge
                        .inner
                        .pending
                        .lock()
                        .unwrap()
                        .contains_key(&close.request_id),
                    "the original close must still have an owner after the batch deadline"
                );
                assert!(
                    receiver.try_recv().is_err(),
                    "no duplicate close while original is uncertain"
                );
                let mut replacement = (outcome == "replacement")
                    .then(|| connect_test_browser(&bridge, "replacement"));
                if outcome == "timeout" {
                    tokio::time::advance(std::time::Duration::from_millis(2000)).await;
                } else {
                    bridge
                        .complete_pending(
                            &close.request_id,
                            "a",
                            "first",
                            Ok(super::BridgeToolResult {
                                result: json!({"message":"removal denied"}),
                                is_error: outcome != "success",
                            }),
                        )
                        .await;
                }
                tokio::task::yield_now().await;
                assert!(bridge.inner.pending.lock().unwrap().is_empty());
                assert!(
                    receiver.try_recv().is_err(),
                    "no automatic retry after completion"
                );
                let warning = String::from_utf8(log.lock().unwrap().clone()).unwrap();
                if outcome == "success" {
                    assert!(warning.is_empty(), "{warning}");
                    continue;
                }
                assert!(
                    warning.contains("owned tab cleanup failed; ownership retained"),
                    "{warning}"
                );
                assert!(warning.contains("tab_id=42"), "{warning}");
                assert!(
                    warning.contains(if outcome == "timeout" {
                        "cleanup timed out"
                    } else {
                        "removal denied"
                    }),
                    "{warning}"
                );
                let target = warning
                    .split("target_id=")
                    .nth(1)
                    .unwrap()
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .trim_matches('"')
                    .to_string();
                // The logged target remains retry-accessible, but never rebinds
                // to a replacement connection even when it reuses tab 42.
                if outcome == "replacement" {
                    let result = facade
                        .close(json!({"targetId":target}).as_object().unwrap().clone())
                        .await
                        .unwrap();
                    assert_eq!(result["closed"], false);
                    assert_eq!(result["status"], "failed");
                    assert!(replacement.as_mut().unwrap().try_recv().is_err());
                } else if outcome == "failure" {
                    let closing = tokio::spawn(async move {
                        facade
                            .close(json!({"targetId":target}).as_object().unwrap().clone())
                            .await
                            .unwrap()
                    });
                    let retry = next_call(&mut receiver).await;
                    assert_eq!(retry.tool, "tabs_close");
                    assert_eq!(retry.args["tabId"], 42);
                    reply(&bridge, &retry, "first", "closed").await;
                    assert_eq!(closing.await.unwrap()["closed"], true);
                } else {
                    // A timeout is uncertain, not permission to send another removal.
                    reply(&bridge, &close, "first", "late close reply").await;
                }
                tokio::task::yield_now().await;
                assert!(receiver.try_recv().is_err());
                assert!(bridge.inner.pending.lock().unwrap().is_empty());
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_dispatch_unregisters_pending_without_reply_or_disconnect() {
        let bridge = BrowserBridge::new();
        let mut receiver = connect_test_browser(&bridge, "first");
        let dispatcher = bridge.clone();
        let running = tokio::spawn(async move {
            dispatcher
                .dispatch("read_page", json!({}), Some(42), None)
                .await
        });
        next_call(&mut receiver).await;
        assert_eq!(bridge.inner.pending.lock().unwrap().len(), 1);
        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        assert_eq!(bridge.extension_count(), 1);
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn recognizes_embedded_tool_errors() {
        assert!(embedded_tool_error(&json!({
            "content": [{"type": "text", "text": "failed"}],
            "isError": true
        })));
        assert!(!embedded_tool_error(&json!({
            "content": [{"type": "text", "text": "ok"}]
        })));
    }

    #[tokio::test]
    async fn stale_disconnect_does_not_unregister_replacement_connection() {
        let bridge = BrowserBridge::new();
        let connect = || ConnectMessage {
            version: "0.2.5".to_string(),
            extension_id: "extension".to_string(),
            instance_id: "browser-1".to_string(),
            token: "secret".to_string(),
            active_tab_url: None,
            browser_info: None,
        };
        let (old_sender, _old_receiver) = mpsc::unbounded_channel();
        bridge.register_browser(connect(), "old-session".to_string(), old_sender, None);
        let (new_sender, _new_receiver) = mpsc::unbounded_channel();
        bridge.register_browser(connect(), "new-session".to_string(), new_sender, None);

        bridge.unregister_browser("browser-1", "old-session").await;

        let status = bridge.status();
        assert_eq!(status.extension_count, 1);
        assert_eq!(status.default_browser_id.as_deref(), Some("browser-1"));
        assert_eq!(status.extensions[0].session_id, "new-session");
    }
}
