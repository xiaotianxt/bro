use std::sync::{Arc, Mutex};

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, ServerHandler,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    bridge::{BridgeError, BridgeToolResult, BrowserBridge},
    facade::BrowserFacade,
    tool_catalog::{self, ToolRoute},
};

#[derive(Clone)]
pub struct BrowserMcpServer {
    bridge: BrowserBridge,
    facade: BrowserFacade,
    /// The target this MCP session last opened or used. The facade is shared
    /// by every session, so the default lives here, never in the facade.
    last_target: Arc<Mutex<Option<String>>>,
}

impl BrowserMcpServer {
    pub fn new(bridge: BrowserBridge, facade: BrowserFacade) -> Self {
        Self {
            bridge,
            facade,
            last_target: Arc::default(),
        }
    }

    /// Fills a missing targetId with this session's last target.
    fn default_target(
        &self,
        args: &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), CallToolResult> {
        if args.contains_key("targetId") {
            return Ok(());
        }
        let last = self.last_target.lock().expect("last target lock").clone();
        match last {
            Some(target) => {
                args.insert("targetId".to_string(), json!(target));
                Ok(())
            }
            None => Err(tool_error(
                "targetId is required: this session has no open target; call browser.open first"
                    .to_string(),
            )),
        }
    }

    /// Records the target a successful or failed call reported.
    fn targeted(&self, result: CallToolResult) -> CallToolResult {
        let target = result
            .structured_content
            .as_ref()
            .and_then(|value| value.get("targetId"))
            .and_then(serde_json::Value::as_str);
        if let Some(target) = target {
            *self.last_target.lock().expect("last target lock") = Some(target.to_string());
        }
        result
    }
}

pub fn streamable_http_service(
    bridge: BrowserBridge,
    cancellation_token: CancellationToken,
) -> StreamableHttpService<BrowserMcpServer, LocalSessionManager> {
    let facade = BrowserFacade::new(bridge.clone());
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(["localhost", "127.0.0.1", "::1"])
        .with_cancellation_token(cancellation_token);
    StreamableHttpService::new(
        move || Ok(BrowserMcpServer::new(bridge.clone(), facade.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    )
}

impl ServerHandler for BrowserMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("bro", env!("CARGO_PKG_VERSION")))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tool_catalog::find_tool(name)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: tool_catalog::all_tools(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let tool_name = request.name.to_string();
        let mut args = request.arguments.unwrap_or_default();

        let Some(route) = tool_catalog::route_for(&tool_name) else {
            return Ok(tool_error(format!("Unknown tool: {tool_name}")));
        };

        if context.ct.is_cancelled() {
            return Ok(tool_error(BridgeError::Cancelled.to_string()));
        }
        let facade = self.facade.with_cancellation(context.ct);
        if matches!(
            route,
            ToolRoute::Observe | ToolRoute::Act | ToolRoute::Step(_)
        ) {
            if let Err(error) = self.default_target(&mut args) {
                return Ok(error);
            }
        }
        match route {
            ToolRoute::FindLogins => Ok(login_result(crate::credentials::find(args).await)),
            ToolRoute::InspectLogin => Ok(login_result(
                crate::credentials::inspect(&self.bridge, args).await,
            )),
            ToolRoute::FillLogin => Ok(login_result(
                crate::credentials::fill(&self.bridge, args).await,
            )),
            ToolRoute::BrowsersContext => Ok(browsers_context(&self.bridge).await),
            ToolRoute::BatchRun => Ok(facade_result(facade.batch_run(args).await)),
            ToolRoute::BatchFlow => Ok(facade_result(facade.batch_flow(args).await)),
            ToolRoute::Extract => Ok(facade_result(facade.extract(args).await)),
            ToolRoute::CurrentExtract => Ok(facade_result(facade.current_extract(args).await)),
            ToolRoute::BatchExtract => Ok(facade_result(facade.batch_extract(args).await)),
            ToolRoute::ConsoleCapture => Ok(facade_result(facade.console_capture(args).await)),
            ToolRoute::NetworkCapture => Ok(facade_result(facade.network_capture(args).await)),
            ToolRoute::Open => Ok(self.targeted(facade_result(facade.open(args).await))),
            ToolRoute::Observe => Ok(self.targeted(rendered_result(
                facade.observe_target(args).await,
                crate::facade::render_observe,
            ))),
            ToolRoute::Act => Ok(self.targeted(rendered_result(
                facade.act(args).await,
                crate::facade::render_act,
            ))),
            ToolRoute::Step(kind) => Ok(self.targeted(rendered_result(
                facade.step(kind, args).await,
                crate::facade::render_act,
            ))),
            ToolRoute::Close => Ok(facade_result(facade.close(args).await)),
            ToolRoute::FlowStart => Ok(facade_result(facade.flow_start(args).await)),
            ToolRoute::FlowObserve => Ok(facade_result(facade.flow_observe(args).await)),
            ToolRoute::FlowAct => Ok(facade_result(facade.flow_act(args).await)),
            ToolRoute::FlowFinish => Ok(facade_result(facade.flow_finish(args).await)),
            ToolRoute::AgentDone => {
                let (tab_ids, browser_id) = match tool_catalog::take_agent_done_args(args) {
                    Ok(value) => value,
                    Err(message) => return Ok(tool_error(message)),
                };
                Ok(agent_done_result(
                    self.bridge.agent_done(tab_ids, browser_id).await,
                ))
            }
            ToolRoute::Forward { tab_id_envelope } => {
                let (forwarded_args, tab_id, browser_id) =
                    tool_catalog::prepare_forward_args(&tool_name, args);
                if tab_id_envelope && tab_id.is_none() {
                    return Ok(tool_error(format!("{tool_name} requires tabId")));
                }
                Ok(into_call_tool_result(
                    self.bridge
                        .dispatch(
                            tool_name,
                            serde_json::Value::Object(forwarded_args),
                            tab_id,
                            browser_id,
                        )
                        .await,
                ))
            }
        }
    }
}

fn login_result(result: Result<serde_json::Value, &'static str>) -> CallToolResult {
    match result {
        Ok(value) => CallToolResult::structured(value),
        Err(message) => tool_error(message),
    }
}

async fn browsers_context(bridge: &BrowserBridge) -> CallToolResult {
    let extension_count = bridge.extension_count();
    let status = match serde_json::to_value(bridge.status()) {
        Ok(value) => value,
        Err(error) => json!({
            "extensionCount": extension_count,
            "statusSerializationError": error.to_string()
        }),
    };

    let mut result = if extension_count == 0 {
        CallToolResult::success(vec![Content::text("No browsers connected.")])
    } else {
        CallToolResult::success(vec![Content::text(format!(
            "Connected browsers: {extension_count}. Use browserId to target a specific browser."
        ))])
    };
    result.structured_content = Some(status);
    result
}

fn facade_result(result: Result<serde_json::Value, crate::facade::FacadeError>) -> CallToolResult {
    match result {
        Ok(value) if value.get("status").and_then(serde_json::Value::as_str) == Some("failed") => {
            CallToolResult::structured_error(value)
        }
        Ok(value) => CallToolResult::structured(value),
        Err(error) => tool_error(error.to_string()),
    }
}

/// Model-facing text in content; the same data stays machine-readable in
/// structuredContent, which adapters use for target tracking.
fn rendered_result(
    result: Result<serde_json::Value, crate::facade::FacadeError>,
    render: fn(&serde_json::Value) -> String,
) -> CallToolResult {
    match result {
        Ok(value) => {
            let content = vec![Content::text(render(&value))];
            let mut result =
                if value.get("status").and_then(serde_json::Value::as_str) == Some("failed") {
                    CallToolResult::error(content)
                } else {
                    CallToolResult::success(content)
                };
            result.structured_content = Some(value);
            result
        }
        Err(error) => tool_error(error.to_string()),
    }
}

fn agent_done_result(result: Result<(), BridgeError>) -> CallToolResult {
    match result {
        Ok(()) => CallToolResult::success(vec![Content::text(
            "Agent session ended. Browser control returned to user.",
        )]),
        Err(error) => bridge_error(error),
    }
}

fn into_call_tool_result(result: Result<BridgeToolResult, BridgeError>) -> CallToolResult {
    match result {
        Ok(result) => bridge_tool_result(result),
        Err(error) => bridge_error(error),
    }
}

fn bridge_tool_result(result: BridgeToolResult) -> CallToolResult {
    match serde_json::from_value::<CallToolResult>(result.result.clone()) {
        Ok(mut parsed) => {
            if result.is_error {
                parsed.is_error = Some(true);
            }
            parsed
        }
        Err(_error) if result.is_error => CallToolResult::structured_error(result.result),
        Err(_error) => CallToolResult::structured(result.result),
    }
}

fn bridge_error(error: BridgeError) -> CallToolResult {
    tool_error(match error {
        BridgeError::NoBrowser => {
            "No extension connected. Load the Bro extension in Chrome.".to_string()
        }
        BridgeError::UnknownBrowser(browser_id) => format!("Browser {browser_id} not found."),
        other => other.to_string(),
    })
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::facade_result;

    #[test]
    fn initialize_identifies_bro_not_the_protocol_sdk() {
        let bridge = crate::bridge::BrowserBridge::new();
        let facade = crate::facade::BrowserFacade::new(bridge.clone());
        let server = super::BrowserMcpServer::new(bridge, facade);
        let info = rmcp::ServerHandler::get_info(&server);
        assert_eq!(info.server_info.name, "bro");
        assert_eq!(info.server_info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn failed_facade_status_becomes_an_mcp_tool_error() {
        let failed = facade_result(Ok(json!({"status": "failed", "stoppedAt": 1})));
        let succeeded = facade_result(Ok(json!({"status": "ok"})));

        assert_eq!(failed.is_error, Some(true));
        assert_ne!(succeeded.is_error, Some(true));
    }
}
