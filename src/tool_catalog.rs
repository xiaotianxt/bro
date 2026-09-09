use std::sync::Arc;

use rmcp::model::{JsonObject, Meta, Tool};
use serde_json::{json, Map, Value};

const ENVELOPE_TAB_TOOLS: &[&str] = &[
    "computer",
    "navigate",
    "resize_window",
    "read_page",
    "find",
    "frames_list",
    "javascript_tool",
    "form_input",
    "get_page_text",
    "extract_page",
    "click_element",
    "scroll_element",
    "fill_element",
    "get_element_info",
    "wait_for_element",
    "read_console_messages",
    "read_network_requests",
    "get_response_body",
    "file_upload",
    "upload_image",
    "gif_creator",
    "shortcuts_list",
    "shortcuts_execute",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoute {
    BrowsersContext,
    BatchRun,
    BatchFlow,
    Extract,
    CurrentExtract,
    BatchExtract,
    ConsoleCapture,
    NetworkCapture,
    FlowStart,
    FlowObserve,
    FlowAct,
    FlowFinish,
    AgentDone,
    Forward { tab_id_envelope: bool },
}

#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub route: ToolRoute,
    pub schema: &'static str,
}

pub fn all_tools() -> Vec<Tool> {
    specs().iter().copied().map(ToolSpec::to_tool).collect()
}

pub fn find_tool(name: &str) -> Option<Tool> {
    specs()
        .iter()
        .find(|spec| spec.name == name)
        .copied()
        .map(ToolSpec::to_tool)
}

pub fn route_for(name: &str) -> Option<ToolRoute> {
    specs()
        .iter()
        .find(|spec| spec.name == name)
        .map(|spec| spec.route)
}

pub fn prepare_forward_args(
    tool_name: &str,
    mut args: JsonObject,
) -> (Map<String, Value>, Option<i64>, Option<String>) {
    let browser_id = take_string(&mut args, "browserId");
    let tab_id = if ENVELOPE_TAB_TOOLS.contains(&tool_name) {
        take_i64(&mut args, "tabId")
    } else {
        None
    };
    (args, tab_id, browser_id)
}

pub fn take_agent_done_args(mut args: JsonObject) -> Result<(Vec<i64>, Option<String>), String> {
    let browser_id = take_string(&mut args, "browserId");
    let tab_ids = match args.remove("tabIds") {
        Some(Value::Array(values)) => {
            let mut ids = Vec::with_capacity(values.len());
            for value in values {
                let Some(id) = value.as_i64() else {
                    return Err("agent_done.tabIds must contain integer tab IDs".to_string());
                };
                ids.push(id);
            }
            ids
        }
        _ => return Err("agent_done requires tabIds".to_string()),
    };
    if tab_ids.is_empty() {
        return Err("agent_done.tabIds must not be empty".to_string());
    }
    Ok((tab_ids, browser_id))
}

impl ToolSpec {
    fn to_tool(self) -> Tool {
        let mut tool = Tool::new(self.name, self.description, Arc::new(schema(self.schema)));
        let mut meta = Map::new();
        if let Some(capability) = capability_for(self.name) {
            meta.insert("bro/capability".to_string(), json!(capability));
        }
        if let Some(visibility) = pi_visibility_for(self.name) {
            meta.insert("bro/piVisibility".to_string(), json!(visibility));
        }
        if !meta.is_empty() {
            tool.meta = Some(Meta(meta));
        }
        tool
    }
}

fn pi_visibility_for(name: &str) -> Option<&'static str> {
    match name {
        "agent_done"
        | "browser.batch.run"
        | "tabs_context_mcp"
        | "tabs_create_mcp"
        | "session_name"
        | "get_page_text"
        | "extract_page"
        | "read_network_requests"
        | "get_response_body" => Some("internal"),
        _ => None,
    }
}

fn capability_for(name: &str) -> Option<&'static str> {
    match name {
        "browsers_context" | "tabs_context" | "tabs_create" | "tabs_claim" | "tabs_finalize"
        | "tabs_activate" | "tabs_close" => Some("tabs"),
        "read_page" | "find" | "form_input" | "click_element" | "scroll_element"
        | "fill_element" | "get_element_info" | "wait_for_element" => Some("accessibility"),
        "frames_list" => Some("frames"),
        "browser.console.capture" | "read_console_messages" => Some("console"),
        "browser.network.capture" | "read_network_requests" | "get_response_body" => {
            Some("network")
        }
        "computer" | "gif_creator" => Some("visual"),
        "file_upload" | "upload_image" => Some("upload"),
        "shortcuts_list" | "shortcuts_execute" => Some("shortcuts"),
        "userscripts_register" | "userscripts_unregister" | "userscripts_list" => {
            Some("userscripts")
        }
        "browser.flow.start"
        | "browser.flow.observe"
        | "browser.flow.act"
        | "browser.flow.finish" => Some("interaction"),
        "navigate" | "resize_window" | "javascript_tool" => Some("advanced"),
        "agent_done"
        | "browser.batch.run"
        | "browser.batch.flow"
        | "browser.extract"
        | "browser.current.extract"
        | "browser.batch.extract"
        | "tabs_context_mcp"
        | "tabs_create_mcp"
        | "session_name"
        | "get_page_text"
        | "extract_page" => Some("internal"),
        _ => None,
    }
}

static SPECS: &[ToolSpec] = &[
    ToolSpec {
        name: "browsers_context",
        description: "List connected browser instances and their browserIds.",
        route: ToolRoute::BrowsersContext,
        schema: "empty",
    },
    ToolSpec {
        name: "agent_done",
        description: "Signal that browser automation is finished for the supplied tab IDs.",
        route: ToolRoute::AgentDone,
        schema: "agent_done",
    },
    ToolSpec {
        name: "browser.batch.run",
        description: "Open URLs in background tabs by default, read page text after short quality readiness, and clean up owned tabs. Defaults: concurrency 6, timeoutMs 12000, cleanup true, active false.",
        route: ToolRoute::BatchRun,
        schema: "browser_batch_run",
    },
    ToolSpec {
        name: "browser.batch.flow",
        description: "Open multiple URLs in parallel, run the same ordered flow steps on each owned tab, and clean up by default. Use for repeated click/wait/eval/read workflows. Defaults: concurrency 6, timeoutMs 12000 per URL, cleanup true, active false.",
        route: ToolRoute::BatchFlow,
        schema: "browser_batch_flow",
    },
    ToolSpec {
        name: "browser.extract",
        description: "Open one URL, use browser-side DOM quiet readiness, then return compact text and extraction diagnostics. Links and a11y fallback are opt-in. Defaults: cleanup true, active false.",
        route: ToolRoute::Extract,
        schema: "browser_extract",
    },
    ToolSpec {
        name: "browser.current.extract",
        description: "Extract the current/default active tab in one call. Use for pages the user already opened. Links and a11y fallback are opt-in.",
        route: ToolRoute::CurrentExtract,
        schema: "browser_current_extract",
    },
    ToolSpec {
        name: "browser.batch.extract",
        description: "Extract multiple URLs in parallel using browser-side DOM quiet readiness. Returns compact text by default; links and a11y fallback are opt-in. Defaults: concurrency 6, cleanup true, active false.",
        route: ToolRoute::BatchExtract,
        schema: "browser_batch_extract",
    },
    ToolSpec {
        name: "browser.console.capture",
        description: "Open one URL, enable browser console instrumentation, evaluate one JavaScript expression that triggers logs, collect console messages, then clean up in one call. Use instead of carrying console-monitor state across model turns.",
        route: ToolRoute::ConsoleCapture,
        schema: "browser_console_capture",
    },
    ToolSpec {
        name: "browser.network.capture",
        description: "Open one URL, enable browser network instrumentation, evaluate one JavaScript expression that triggers requests, collect matching request metadata and response bodies, then clean up in one call. Use instead of carrying network-monitor state across model turns.",
        route: ToolRoute::NetworkCapture,
        schema: "browser_network_capture",
    },
    ToolSpec {
        name: "browser.flow.start",
        description: "Start a default background browser flow for one URL and keep its tab in server memory. Defaults: active false, cleanup true.",
        route: ToolRoute::FlowStart,
        schema: "browser_flow_start",
    },
    ToolSpec {
        name: "browser.flow.observe",
        description: "Observe a flow as a compact accessibility snapshot by default, including iframe and Shadow DOM controls with actionable refs. Each observation replaces this tab's previous refs. Use mode text only for plain main-frame text.",
        route: ToolRoute::FlowObserve,
        schema: "browser_flow_observe",
    },
    ToolSpec {
        name: "browser.flow.act",
        description: "Run ordered steps on the owned tab. click/fill/select accept snapshot refId or css; scroll requires refId and optionally direction/amount (CSS pixels). Ref scrolling foregrounds its target and waits for rendering. Combine scroll and read_text steps to verify intermediate UI states in one call; read_text does not replace refs. Never combine refId with css/frameId. Eval is an awaited expression. Stops at the first failed step.",
        route: ToolRoute::FlowAct,
        schema: "browser_flow_act",
    },
    ToolSpec {
        name: "browser.flow.finish",
        description: "Finish a browser flow session, removing server state and cleaning up the owned tab by default.",
        route: ToolRoute::FlowFinish,
        schema: "browser_flow_finish",
    },
    ToolSpec {
        name: "tabs_context",
        description: "Get the context of open browser tabs and tab groups.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_context",
    },
    ToolSpec {
        name: "tabs_create",
        description: "Create a new browser tab, optionally navigating to a URL.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_create",
    },
    ToolSpec {
        name: "tabs_context_mcp",
        description: "Get tab context for MCP sessions.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_context_mcp",
    },
    ToolSpec {
        name: "tabs_create_mcp",
        description: "Create a new background tab in an MCP session tab group.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_create_mcp",
    },
    ToolSpec {
        name: "session_name",
        description: "Name a browser automation session and update its tab group title when present.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "session_name",
    },
    ToolSpec {
        name: "tabs_claim",
        description: "Claim an existing browser tab for an automation session without making it agent-owned.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_claim",
    },
    ToolSpec {
        name: "tabs_finalize",
        description: "Finalize a browser automation session, closing owned tabs unless they are explicitly kept.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_finalize",
    },
    ToolSpec {
        name: "tabs_activate",
        description: "Activate a browser tab by its numeric tab ID.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_tab_id",
    },
    ToolSpec {
        name: "tabs_close",
        description: "Close a browser tab by its numeric tab ID.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "tabs_tab_id",
    },
    forward(
        "computer",
        "Interact with the browser by screenshot, click, type, scroll, drag, or key input. Real input actions bring the target tab to the foreground because Chromium can stall Input.* dispatch for background targets; screenshot and zoom remain background-capable.",
        "computer",
    ),
    forward(
        "navigate",
        "Navigate a tab to a URL or through browser history.",
        "navigate",
    ),
    forward(
        "resize_window",
        "Resize the browser window containing the tab.",
        "resize_window",
    ),
    forward(
        "read_page",
        "Read a browser-native accessibility snapshot with inline frame trees and Shadow DOM labels. Refs are opaque, bound to this tab/snapshot/document, and replaced by the next read_page/find/a11y observation. Reobserve after navigation or DOM replacement; never guess refs.",
        "read_page",
    ),
    forward(
        "find",
        "Find a page element by natural language description.",
        "find",
    ),
    forward(
        "frames_list",
        "List the main frame and child frames for a tab, including stable frameIds for frame-aware flow eval, click, fill, select, and read_text steps.",
        "frames_list",
    ),
    forward(
        "javascript_tool",
        "Execute JavaScript in the page context, optionally targeting a frameId from frames_list.",
        "javascript_tool",
    ),
    forward(
        "form_input",
        "Set and verify a form control value using an opaque ref from the latest snapshot, including iframe/Shadow DOM controls. For selects accept an option value or unique visible label. Disabled, read-only, hidden and stale controls fail.",
        "form_input",
    ),
    forward(
        "get_page_text",
        "Extract plain text content from the current page.",
        "get_page_text",
    ),
    forward(
        "extract_page",
        "Extract visible text and links after browser-side DOM quiet readiness.",
        "extract_page",
    ),
    forward("click_element", "Dispatch a trusted click to the exact snapshot ref, including frame/Shadow DOM targets. Foregrounds the tab/window. Covered, disabled or stale targets fail; observe the application result after dispatch.", "ref_id"),
    forward(
        "scroll_element",
        "Scroll an exact snapshot ref by CSS pixels. Foregrounds the tab and target frame, then waits for rendering/scroll handlers. Returns before/after offsets, delta, extent, moved and boundary (null for unsupported writing modes). Does not synthesize events or retry. Use flow.act scroll + read_text for multi-step UI verification.",
        "scroll_element",
    ),
    forward(
        "fill_element",
        "Set text in a form control or contenteditable using its latest opaque ref, with native setters and composed input/change events. Observe the application result.",
        "fill_element",
    ),
    forward(
        "get_element_info",
        "Inspect runtime details for a page element by refId.",
        "ref_id",
    ),
    forward(
        "wait_for_element",
        "Wait until an element appears by refId or description.",
        "wait_for_element",
    ),
    forward(
        "read_console_messages",
        "Begin or read best-effort console monitoring for one tab. Prefer browser.console.capture when an action must trigger the message in a reliable one-call workflow.",
        "read_console_messages",
    ),
    forward(
        "read_network_requests",
        "Begin or read best-effort network monitoring for one tab. Monitoring is extension-memory state and may not survive model turns; prefer browser.network.capture when an action must trigger the request. Use timeoutMs 0 only for deliberate multi-call debugging.",
        "read_network_requests",
    ),
    forward(
        "get_response_body",
        "Retrieve a network response body by request ID while the originating debugger session is still available. Prefer browser.network.capture for trigger-and-body workflows.",
        "get_response_body",
    ),
    forward(
        "file_upload",
        "Inject a file into a file input identified by refId.",
        "file_upload",
    ),
    forward(
        "upload_image",
        "Upload screenshot or image data through a file input.",
        "upload_image",
    ),
    forward(
        "gif_creator",
        "Record browser automation operations as a GIF.",
        "gif_creator",
    ),
    forward(
        "shortcuts_list",
        "List keyboard shortcuts available for a browser tab.",
        "tab_only",
    ),
    forward(
        "shortcuts_execute",
        "Execute a keyboard shortcut in a browser tab.",
        "shortcuts_execute",
    ),
    ToolSpec {
        name: "userscripts_register",
        description: "Register one or more user scripts via chrome.userScripts. Scripts auto-inject on matching pages and persist across sessions.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "userscripts_register",
    },
    ToolSpec {
        name: "userscripts_unregister",
        description: "Unregister user scripts by ID, or all scripts if no IDs are provided.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "userscripts_unregister",
    },
    ToolSpec {
        name: "userscripts_list",
        description: "List registered user scripts, optionally filtered by ID.",
        route: ToolRoute::Forward {
            tab_id_envelope: false,
        },
        schema: "userscripts_list",
    },
];

fn specs() -> &'static [ToolSpec] {
    SPECS
}

const fn forward(name: &'static str, description: &'static str, schema: &'static str) -> ToolSpec {
    ToolSpec {
        name,
        description,
        route: ToolRoute::Forward {
            tab_id_envelope: true,
        },
        schema,
    }
}

fn schema(kind: &str) -> JsonObject {
    let properties = match kind {
        "empty" => Map::new(),
        "agent_done" => props(&[
            (
                "tabIds",
                json!({"type":"array","items":{"type":"integer"},"minItems":1,"description":"Tab IDs the agent has finished operating on."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "browser_batch_run" => props(&[
            (
                "urls",
                json!({"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"description":"Minimal input: URLs to open, read as text, and close by default."}),
            ),
            (
                "inputs",
                json!({"type":"array","minItems":1,"items":{"type":"object","required":["url"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to input-<n>."},"url":{"type":"string","format":"uri"}}}}),
            ),
            (
                "concurrency",
                json!({"type":"integer","minimum":1,"maximum":16,"default":6}),
            ),
            (
                "timeoutMs",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":12000}),
            ),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_extract" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            (
                "id",
                json!({"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to url-1."}),
            ),
            (
                "minChars",
                json!({"type":"integer","minimum":1,"maximum":10000,"default":120,"description":"Minimum content size for ready quality; not a sleep duration."}),
            ),
            (
                "maxChars",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
            ),
            (
                "maxLinks",
                json!({"type":"integer","minimum":0,"maximum":200,"default":20}),
            ),
            (
                "includeA11y",
                json!({"type":"boolean","default":false,"description":"When true, read the accessibility tree as a fallback if browser-side DOM extraction is not ready."}),
            ),
            (
                "includeLinks",
                json!({"type":"boolean","default":false,"description":"When true, include extracted links. Keep false unless URLs are part of the answer."}),
            ),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_current_extract" => props(&[
            (
                "id",
                json!({"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to current."}),
            ),
            (
                "minChars",
                json!({"type":"integer","minimum":1,"maximum":10000,"default":120,"description":"Minimum content size for ready quality; not a sleep duration."}),
            ),
            (
                "maxChars",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
            ),
            (
                "maxLinks",
                json!({"type":"integer","minimum":0,"maximum":200,"default":20}),
            ),
            (
                "includeA11y",
                json!({"type":"boolean","default":false,"description":"When true, read the accessibility tree as a fallback if browser-side DOM extraction is not ready."}),
            ),
            (
                "includeLinks",
                json!({"type":"boolean","default":false,"description":"When true, include extracted links. Keep false unless URLs are part of the answer."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "browser_batch_extract" => props(&[
            (
                "urls",
                json!({"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"description":"URLs to extract using browser-side readiness."}),
            ),
            (
                "inputs",
                json!({"type":"array","minItems":1,"items":{"type":"object","required":["url"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to input-<n>."},"url":{"type":"string","format":"uri"}}}}),
            ),
            (
                "concurrency",
                json!({"type":"integer","minimum":1,"maximum":16,"default":6}),
            ),
            (
                "minChars",
                json!({"type":"integer","minimum":1,"maximum":10000,"default":120,"description":"Minimum content size for ready quality; not a sleep duration."}),
            ),
            (
                "maxChars",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
            ),
            (
                "maxLinks",
                json!({"type":"integer","minimum":0,"maximum":200,"default":20}),
            ),
            (
                "includeA11y",
                json!({"type":"boolean","default":false,"description":"When true, read the accessibility tree as a fallback if browser-side DOM extraction is not ready."}),
            ),
            (
                "includeLinks",
                json!({"type":"boolean","default":false,"description":"When true, include extracted links. Keep false unless URLs are part of the answer."}),
            ),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_console_capture" => props(&[
            ("url", json!({"type":"string","format":"uri","description":"Page to open before console capture starts."})),
            ("code", json!({"type":"string","minLength":1,"description":"JavaScript trigger evaluated after console monitoring starts. Returned Promises are awaited; a zero-argument function expression is invoked automatically."})),
            ("timeoutMs", json!({"type":"integer","minimum":1,"maximum":20000,"default":5000,"description":"Maximum time to wait for the first console message."})),
            ("maxMessages", json!({"type":"integer","minimum":1,"maximum":500,"default":100})),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_network_capture" => props(&[
            ("url", json!({"type":"string","format":"uri","description":"Page to open before network capture starts."})),
            ("code", json!({"type":"string","minLength":1,"description":"JavaScript trigger evaluated after monitoring starts. Returned Promises are awaited; a zero-argument function expression is invoked automatically. Examples: fetch('/api') or () => fetch('/api')."})),
            ("urlIncludes", json!({"type":"string","minLength":1,"description":"Only return requests whose URL contains this substring."})),
            ("timeoutMs", json!({"type":"integer","minimum":1,"maximum":20000,"default":10000,"description":"Maximum time to wait for a matching request to finish."})),
            ("includeResponseBodies", json!({"type":"boolean","default":true,"description":"Include bounded response bodies for finished matching requests."})),
            ("includeHeaders", json!({"type":"boolean","default":false,"description":"Include request and response headers. Keep false unless headers are required."})),
            ("includePostData", json!({"type":"boolean","default":false,"description":"Include request post bodies. Keep false unless request payloads are required."})),
            ("maxBodyChars", json!({"type":"integer","minimum":1,"maximum":60000,"default":20000,"description":"Total response-body character budget shared across matching requests."})),
            ("maxRequests", json!({"type":"integer","minimum":1,"maximum":100,"default":20})),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_batch_flow" => props(&[
            (
                "urls",
                json!({"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"description":"URLs to open in owned background tabs."}),
            ),
            (
                "inputs",
                json!({"type":"array","minItems":1,"items":{"type":"object","required":["url"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to input-<n>."},"url":{"type":"string","format":"uri"}}}}),
            ),
            (
                "steps",
                flow_steps_schema("Ordered CSS/eval flow steps to run on each newly created tab. Snapshot refs from other tabs cannot be reused.", false),
            ),
            (
                "concurrency",
                json!({"type":"integer","minimum":1,"maximum":16,"default":6}),
            ),
            (
                "timeoutMs",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":12000,"description":"Per-URL timeout including page open, steps, and cleanup scheduling."}),
            ),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_flow_start" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            ("browserId", browser_id_schema()),
            ("active", json!({"type":"boolean","default":false})),
            ("cleanup", json!({"type":"boolean","default":true})),
        ]),
        "browser_flow_observe" => props(&[
            ("sessionId", json!({"type":"string","minLength":1})),
            (
                "mode",
                json!({"type":"string","enum":["text","a11y"],"default":"a11y"}),
            ),
        ]),
        "browser_flow_act" => props(&[
            ("sessionId", json!({"type":"string","minLength":1})),
            (
                "steps",
                flow_steps_schema("Ordered steps. Combine actions using refs from the latest accessibility observation, or known CSS selectors. Refs include their frame identity.", true),
            ),
        ]),
        "browser_flow_finish" => props(&[
            ("sessionId", json!({"type":"string","minLength":1})),
            ("cleanup", json!({"type":"boolean"})),
        ]),
        "tabs_context" => props(&[
            ("sessionId", json!({"type":"string"})),
            ("all", json!({"type":"boolean"})),
            ("tabId", tab_id_schema("Anchor tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_create" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            ("sessionId", json!({"type":"string"})),
            ("active", json!({"type":"boolean","default":false})),
            ("windowId", json!({"type":"integer"})),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_context_mcp" => props(&[
            ("sessionId", json!({"type":"string"})),
            ("tabId", tab_id_schema("Anchor tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_create_mcp" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            ("sessionId", json!({"type":"string"})),
            ("tabId", tab_id_schema("Opener or anchor tab ID.")),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "session_name" => props(&[
            ("sessionId", json!({"type":"string","minLength":1})),
            (
                "name",
                json!({"type":"string","minLength":1,"description":"Human-readable browser automation session name."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_claim" => props(&[
            ("sessionId", json!({"type":"string"})),
            (
                "tabId",
                tab_id_schema("Existing numeric tab ID to claim for this automation session."),
            ),
            (
                "active",
                json!({"type":"boolean","default":false,"description":"When true, activate and focus the claimed tab."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_finalize" => props(&[
            ("sessionId", json!({"type":"string"})),
            (
                "closeTabIds",
                json!({"type":"array","items":{"type":"integer"},"description":"Explicit tab IDs to close during finalization."}),
            ),
            (
                "keep",
                json!({"type":"array","items":{"type":"object","required":["tabId"],"additionalProperties":false,"properties":{"tabId":{"type":"integer"},"status":{"type":"string","enum":["deliverable","handoff","keep"]},"reason":{"type":"string"}}},"description":"Tabs to keep open after finalization."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "tabs_tab_id" | "tab_only" => props(&[
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "get_page_text" => props(&[
            (
                "maxChars",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":12000,"description":"Maximum number of text characters to return."}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "computer" => props(&[
            (
                "action",
                json!({"type":"string","enum":["screenshot","zoom","left_click","right_click","middle_click","double_click","triple_click","hover","scroll","left_click_drag","type","key"]}),
            ),
            (
                "coordinate",
                json!({"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2}),
            ),
            (
                "start_coordinate",
                json!({"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2}),
            ),
            ("text", json!({"type":"string"})),
            (
                "direction",
                json!({"type":"string","enum":["up","down","left","right"]}),
            ),
            ("amount", json!({"type":"number"})),
            (
                "region",
                json!({"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4}),
            ),
            (
                "quality",
                json!({"type":"integer","minimum":10,"maximum":95,"default":55,"description":"JPEG quality for screenshot/zoom actions. Raise only when visual detail matters."}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID to operate on.")),
            ("browserId", browser_id_schema()),
        ]),
        "navigate" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            (
                "direction",
                json!({"type":"string","enum":["back","forward"]}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID to navigate.")),
            ("browserId", browser_id_schema()),
        ]),
        "resize_window" => props(&[
            ("width", json!({"type":"integer","minimum":1})),
            ("height", json!({"type":"integer","minimum":1})),
            (
                "tabId",
                tab_id_schema("Numeric tab ID whose window should be resized."),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "read_page" => props(&[
            (
                "filter",
                json!({"type":"string","enum":["all","interactive"],"default":"all"}),
            ),
            ("depth", json!({"type":"integer","minimum":1,"maximum":100,"default":20})),
            ("maxChars", json!({"type":"integer","minimum":1,"maximum":60000,"default":16000})),
            ("refId", json!({"type":"string","description":"Optional latest ref to scope the AX subtree within its document. Omit to include all frames."})),
            ("compact", json!({"type":"boolean","default":true})),
            ("tabId", tab_id_schema("Numeric tab ID to read.")),
            ("browserId", browser_id_schema()),
        ]),
        "find" => props(&[
            ("description", json!({"type":"string","minLength":1})),
            ("refId", json!({"type":"string"})),
            ("tabId", tab_id_schema("Numeric tab ID to search.")),
            ("browserId", browser_id_schema()),
        ]),
        "frames_list" => props(&[
            ("tabId", tab_id_schema("Numeric tab ID whose frame tree should be listed.")),
            ("browserId", browser_id_schema()),
        ]),
        "javascript_tool" => props(&[
            ("code", json!({"type":"string","minLength":1})),
            (
                "awaitPromise",
                json!({"type":"boolean","default":false,"description":"Await any returned Promise before serializing the result."}),
            ),
            ("frameId", json!({"type":"string","minLength":1,"description":"Optional child frameId from frames_list. Omit for the main frame."})),
            ("tabId", tab_id_schema("Numeric tab ID to run code in.")),
            ("browserId", browser_id_schema()),
        ]),
        "form_input" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            ("value", json!({"type":"string"})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "ref_id" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "scroll_element" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            (
                "direction",
                json!({"type":"string","enum":["up","down","left","right"],"default":"down"}),
            ),
            ("amount", json!({"type":"integer","minimum":1,"maximum":10000,"default":400,"description":"Scroll distance in CSS pixels."})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "fill_element" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            ("text", json!({"type":"string"})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "wait_for_element" => props(&[
            ("refId", json!({"type":"string"})),
            ("description", json!({"type":"string"})),
            ("timeout", json!({"type":"integer","minimum":1,"maximum":20000,"default":10000})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "read_console_messages" => props(&[
            ("clear", json!({"type":"boolean","default":false})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "read_network_requests" => props(&[
            ("clear", json!({"type":"boolean","default":false})),
            (
                "filter",
                json!({"type":"string","enum":["all","failed"],"default":"all"}),
            ),
            (
                "timeoutMs",
                json!({"type":"integer","minimum":0,"maximum":600000,"default":30000,"description":"Idle lifetime for best-effort monitoring. Use 0 to request no timer, but prefer browser.network.capture across model turns."}),
            ),
            (
                "includeHeaders",
                json!({"type":"boolean","default":false,"description":"Include request and response headers for each entry."}),
            ),
            (
                "includeDetails",
                json!({"type":"boolean","default":false,"description":"Include mimeType, protocol, remote address, cache/service-worker flags, and encoded data length."}),
            ),
            (
                "includeTiming",
                json!({"type":"boolean","default":false,"description":"Include the CDP ResourceTiming object for each entry."}),
            ),
            (
                "includePostData",
                json!({"type":"boolean","default":false,"description":"Include request post body for each entry."}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "get_response_body" => props(&[
            ("requestId", json!({"type":"string","minLength":1})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "extract_page" => props(&[
            (
                "minChars",
                json!({"type":"integer","minimum":1,"maximum":10000,"default":120}),
            ),
            (
                "quietMs",
                json!({"type":"integer","minimum":50,"maximum":1000,"default":250}),
            ),
            (
                "guardMs",
                json!({"type":"integer","minimum":500,"maximum":8000,"default":8000}),
            ),
            (
                "maxChars",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
            ),
            (
                "maxLinks",
                json!({"type":"integer","minimum":0,"maximum":200,"default":20}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "file_upload" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            ("fileName", json!({"type":"string","minLength":1})),
            ("mimeType", json!({"type":"string","minLength":1})),
            ("data", json!({"type":"string","minLength":1})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "upload_image" => props(&[
            ("refId", json!({"type":"string","minLength":1})),
            ("screenshotData", json!({"type":"string"})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "gif_creator" => props(&[
            (
                "action",
                json!({"type":"string","enum":["start","stop","export"]}),
            ),
            (
                "fps",
                json!({"type":"integer","minimum":1,"maximum":30,"default":2}),
            ),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "shortcuts_execute" => props(&[
            ("shortcut", json!({"type":"string","minLength":1})),
            ("tabId", tab_id_schema("Numeric tab ID.")),
            ("browserId", browser_id_schema()),
        ]),
        "userscripts_register" => props(&[
            (
                "scripts",
                json!({"type":"array","minItems":1,"items":{"type":"object","required":["id","matches","js"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1},"description":{"type":"string","description":"Short human-readable explanation of what the script does."},"matches":{"type":"array","items":{"type":"string"},"minItems":1},"js":{"type":"array","items":{"type":"object","required":[],"additionalProperties":false,"properties":{"code":{"type":"string"},"file":{"type":"string"}}},"minItems":1},"runAt":{"type":"string","enum":["document_start","document_end","document_idle"]},"allFrames":{"type":"boolean"},"excludeMatches":{"type":"array","items":{"type":"string"}},"world":{"type":"string","enum":["USER_SCRIPT","MAIN"]}}}}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "userscripts_unregister" => props(&[
            (
                "ids",
                json!({"type":"array","items":{"type":"string"},"description":"Script IDs to unregister. Omit to unregister all."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        "userscripts_list" => props(&[
            (
                "ids",
                json!({"type":"array","items":{"type":"string"},"description":"Script IDs to filter by. Omit to list all."}),
            ),
            ("browserId", browser_id_schema()),
        ]),
        _ => Map::new(),
    };

    let mut object = Map::new();
    object.insert("type".to_string(), Value::String("object".to_string()));
    object.insert("properties".to_string(), Value::Object(properties));
    object.insert("additionalProperties".to_string(), Value::Bool(false));
    if let Some(required) = required_fields(kind) {
        object.insert(
            "required".to_string(),
            Value::Array(
                required
                    .iter()
                    .map(|field| Value::String((*field).to_string()))
                    .collect(),
            ),
        );
    }
    object
}

fn required_fields(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "agent_done" => Some(&["tabIds"]),
        "browser_extract" => Some(&["url"]),
        "browser_console_capture" | "browser_network_capture" => Some(&["url", "code"]),
        "browser_batch_flow" => Some(&["steps"]),
        "browser_flow_start" => Some(&["url"]),
        "browser_flow_observe" | "browser_flow_finish" => Some(&["sessionId"]),
        "browser_flow_act" => Some(&["sessionId", "steps"]),
        _ => None,
    }
}

fn flow_steps_schema(description: &str, allow_refs: bool) -> Value {
    let companions = if allow_refs {
        "Required companion fields: goto=url, eval=code, click=one of refId/css, fill/select=one of refId/css+value, scroll=refId (direction down, amount 400 CSS pixels by default), wait=ms. read_text reads visible main-frame text without invalidating refs. refId cannot be combined with css/frameId."
    } else {
        "Required companion fields: goto=url, eval=code, click=css, fill/select=css+value, wait=ms; read_text has none. These new tabs have no existing snapshot refs."
    };
    let mut operations = vec![
        "goto",
        "eval",
        "click",
        "fill",
        "select",
        "wait",
        "read_text",
    ];
    if allow_refs {
        operations.push("scroll");
    }
    let mut properties = props(&[
        (
            "type",
            json!({"type":"string","enum":operations,"description":companions}),
        ),
        (
            "url",
            json!({"type":"string","format":"uri","description":"Destination for goto."}),
        ),
        (
            "code",
            json!({"type":"string","description":"JavaScript expression for eval. Returned Promises are awaited. Do not use top-level return; wrap statements in an IIFE."}),
        ),
        (
            "css",
            json!({"type":"string","minLength":1,"description":"CSS selector for click/fill/select. Mutually exclusive with refId when refs are supported."}),
        ),
        (
            "frameId",
            json!({"type":"string","minLength":1,"description":"Optional frameId for eval, CSS-based click/fill/select, or read_text. Not allowed with refId. Omit for the main frame."}),
        ),
        (
            "value",
            json!({"type":"string","description":"Text for fill; option value for CSS select, or option value/unique visible label for ref-based select."}),
        ),
        (
            "ms",
            json!({"type":"integer","minimum":0,"maximum":30000,"description":"Delay in milliseconds for wait."}),
        ),
    ]);
    if allow_refs {
        properties.insert("refId".to_string(), json!({"type":"string","minLength":1,"description":"Opaque latest-snapshot ref for click/fill/select/scroll. Identifies its frame. Do not combine with css/frameId. Remains valid across read_text, but not a new snapshot/navigation/replacement."}));
        properties.insert("direction".to_string(), json!({"type":"string","enum":["up","down","left","right"],"default":"down","description":"Direction for scroll."}));
        properties.insert("amount".to_string(), json!({"type":"integer","minimum":1,"maximum":10000,"default":400,"description":"CSS pixels for scroll; movement is clamped by the actual scroll range."}));
    }
    json!({"type":"array","minItems":1,"description":description,"items":{"type":"object","required":["type"],"additionalProperties":false,"properties":properties}})
}

fn props(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(name, value)| ((*name).to_string(), value.clone()))
        .collect()
}

fn tab_id_schema(description: &str) -> Value {
    json!({"type":"integer","description":description})
}

fn browser_id_schema() -> Value {
    json!({"type":"string","description":"Target browser instanceId. Omit to use the default browser."})
}

fn take_string(args: &mut JsonObject, key: &str) -> Option<String> {
    args.remove(key).and_then(|value| match value {
        Value::String(s) if !s.is_empty() => Some(s),
        _ => None,
    })
}

fn take_i64(args: &mut JsonObject, key: &str) -> Option<i64> {
    args.remove(key).and_then(|value| value.as_i64())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{find_tool, prepare_forward_args, route_for, schema, ToolRoute};

    #[test]
    fn every_tab_enveloped_tool_extracts_tab_and_browser_ids() {
        for tool in super::specs().iter().filter(|tool| {
            matches!(
                tool.route,
                ToolRoute::Forward {
                    tab_id_envelope: true
                }
            )
        }) {
            let (arguments, tab_id, browser_id) = prepare_forward_args(
                tool.name,
                json!({"tabId": 42, "browserId": "browser-1"})
                    .as_object()
                    .expect("arguments should be an object")
                    .clone(),
            );

            assert_eq!(tab_id, Some(42), "{} did not extract tabId", tool.name);
            assert_eq!(
                browser_id.as_deref(),
                Some("browser-1"),
                "{} did not extract browserId",
                tool.name
            );
            assert!(!arguments.contains_key("tabId"));
            assert!(!arguments.contains_key("browserId"));
        }
    }

    #[test]
    fn flow_schema_exposes_select_and_eval_contract() {
        let schema = schema("browser_flow_act");
        let step = &schema["properties"]["steps"]["items"];
        let operations = step["properties"]["type"]["enum"]
            .as_array()
            .expect("flow operations should be an array");

        assert!(operations.iter().any(|value| value == "select"));
        assert!(operations.iter().any(|value| value == "scroll"));
        assert_eq!(step["properties"]["amount"]["maximum"], 10000);
        let batch = super::schema("browser_batch_flow");
        assert!(batch["properties"]["steps"]["items"]["properties"]["amount"].is_null());
        assert!(step["properties"]["code"]["description"]
            .as_str()
            .is_some_and(|description| description.contains("expression")));
        assert_eq!(step["properties"]["frameId"]["type"], "string");
        assert_eq!(step["properties"]["refId"]["type"], "string");
        assert_eq!(
            super::schema("browser_flow_observe")["properties"]["mode"]["default"],
            "a11y"
        );
    }

    #[test]
    fn tools_publish_server_owned_capability_metadata() {
        let tool = find_tool("userscripts_register").expect("tool should exist");
        let meta = tool.meta.expect("tool should include metadata");
        let internal = find_tool("agent_done").expect("tool should exist");
        let internal_meta = internal.meta.expect("tool should include metadata");

        assert_eq!(meta.0["bro/capability"], "userscripts");
        assert_eq!(internal_meta.0["bro/piVisibility"], "internal");
    }

    #[test]
    fn frame_listing_is_a_tab_enveloped_tool() {
        assert_eq!(
            route_for("frames_list"),
            Some(ToolRoute::Forward {
                tab_id_envelope: true
            })
        );
        let schema = schema("frames_list");
        assert_eq!(schema["properties"]["tabId"]["type"], "integer");
    }

    #[test]
    fn console_capture_is_a_first_class_facade() {
        assert_eq!(
            route_for("browser.console.capture"),
            Some(ToolRoute::ConsoleCapture)
        );
        let schema = schema("browser_console_capture");
        assert_eq!(schema["required"], serde_json::json!(["url", "code"]));
    }

    #[test]
    fn network_capture_is_a_first_class_facade() {
        assert_eq!(
            route_for("browser.network.capture"),
            Some(ToolRoute::NetworkCapture)
        );
        let schema = schema("browser_network_capture");
        assert_eq!(schema["required"], serde_json::json!(["url", "code"]));
        assert_eq!(
            schema["properties"]["includeResponseBodies"]["default"],
            true
        );
    }
}
