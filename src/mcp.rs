use std::sync::Arc;

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, Content, ListToolsResult, PaginatedRequestParams,
        ServerCapabilities, ServerInfo, Tool,
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
}

impl BrowserMcpServer {
    pub fn new(bridge: BrowserBridge, facade: BrowserFacade) -> Self {
        Self { bridge, facade }
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
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let tool_name = request.name.to_string();
        let args = request.arguments.unwrap_or_default();

        let Some(route) = tool_catalog::route_for(&tool_name) else {
            return Ok(tool_error(format!("Unknown tool: {tool_name}")));
        };

        match route {
            ToolRoute::BrowsersContext => Ok(browsers_context(&self.bridge).await),
            ToolRoute::BatchRun => Ok(facade_result(self.facade.batch_run(args).await)),
            ToolRoute::BatchFlow => Ok(facade_result(self.facade.batch_flow(args).await)),
            ToolRoute::Extract => Ok(facade_result(self.facade.extract(args).await)),
            ToolRoute::CurrentExtract => Ok(facade_result(self.facade.current_extract(args).await)),
            ToolRoute::BatchExtract => Ok(facade_result(self.facade.batch_extract(args).await)),
            ToolRoute::FlowStart => Ok(facade_result(self.facade.flow_start(args).await)),
            ToolRoute::FlowObserve => Ok(facade_result(self.facade.flow_observe(args).await)),
            ToolRoute::FlowAct => Ok(facade_result(self.facade.flow_act(args).await)),
            ToolRoute::FlowFinish => Ok(facade_result(self.facade.flow_finish(args).await)),
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
        Ok(value) => CallToolResult::structured(value),
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
