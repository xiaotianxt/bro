use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::native::NativeBrowserInfo;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub user_agent: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionToServer {
    Connect(ConnectMessage),
    ToolResult(ToolResultMessage),
    ToolError(ToolErrorMessage),
    Pong(PongMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectMessage {
    pub version: String,
    pub extension_id: String,
    pub instance_id: String,
    pub token: String,
    pub active_tab_url: Option<String>,
    pub browser_info: Option<BrowserInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    pub request_id: String,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorMessage {
    pub request_id: String,
    pub error: BridgeErrorPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeErrorPayload {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PongMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToExtension {
    Connected(ConnectedMessage),
    ToolCall(ToolCallMessage),
    Ping(PingMessage),
    AgentDone(AgentDoneMessage),
    ReloadExtension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedMessage {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallMessage {
    pub request_id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDoneMessage {
    pub tab_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    pub browser_id: String,
    pub extension_id: String,
    pub session_id: String,
    pub active_tab_url: Option<String>,
    pub browser_info: Option<BrowserInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_info: Option<NativeBrowserInfo>,
    pub last_seen_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub extension_count: usize,
    pub default_browser_id: Option<String>,
    pub extensions: Vec<ExtensionStatus>,
}

impl ExtensionToServer {
    pub fn parse_json(input: &str) -> serde_json::Result<Self> {
        serde_json::from_str(input)
    }
}

impl ServerToExtension {
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ExtensionToServer, ServerToExtension, ToolCallMessage};

    #[test]
    fn parses_connect_json() {
        let raw = json!({
            "type": "connect",
            "version": "1.0",
            "extensionId": "extension",
            "instanceId": "browser-1",
            "token": "secret",
            "activeTabUrl": "https://example.test",
            "browserInfo": {
                "name": "Google Chrome",
                "version": "148",
                "platform": "macOS",
                "userAgent": "agent"
            }
        })
        .to_string();

        let parsed = ExtensionToServer::parse_json(&raw).unwrap();
        match parsed {
            ExtensionToServer::Connect(connect) => {
                assert_eq!(connect.version, "1.0");
                assert_eq!(connect.extension_id, "extension");
                assert_eq!(connect.instance_id, "browser-1");
                assert_eq!(connect.token, "secret");
                assert_eq!(
                    connect.active_tab_url.as_deref(),
                    Some("https://example.test")
                );
                assert_eq!(connect.browser_info.unwrap().user_agent, "agent");
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_tool_result_and_tool_error_json() {
        let result = ExtensionToServer::parse_json(
            r#"{"type":"tool_result","requestId":"req-1","result":{"content":[{"type":"text","text":"ok"}]}}"#,
        )
        .unwrap();
        match result {
            ExtensionToServer::ToolResult(message) => {
                assert_eq!(message.request_id, "req-1");
                assert_eq!(message.result["content"][0]["text"], "ok");
            }
            other => panic!("unexpected message: {other:?}"),
        }

        let error = ExtensionToServer::parse_json(
            r#"{"type":"tool_error","requestId":"req-2","error":{"message":"failed","code":"bad"}}"#,
        )
        .unwrap();
        match error {
            ExtensionToServer::ToolError(message) => {
                assert_eq!(message.request_id, "req-2");
                assert_eq!(message.error.message, "failed");
                assert_eq!(message.error.code.as_deref(), Some("bad"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn serializes_server_messages_with_protocol_field_names() {
        let message = ServerToExtension::ToolCall(ToolCallMessage {
            request_id: "req-3".to_string(),
            tool: "get_page_text".to_string(),
            args: json!({}),
            tab_id: Some(123),
        });

        let raw = message.to_json().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw).unwrap(),
            json!({
                "type": "tool_call",
                "requestId": "req-3",
                "tool": "get_page_text",
                "args": {},
                "tabId": 123
            })
        );
    }
}
