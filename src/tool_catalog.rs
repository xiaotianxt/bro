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
    "debugger_diagnose",
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
    FindLogins,
    InspectLogin,
    FillLogin,
    BrowsersContext,
    BatchRun,
    BatchFlow,
    Extract,
    CurrentExtract,
    BatchExtract,
    ConsoleCapture,
    NetworkCapture,
    Open,
    Observe,
    Act,
    Close,
    /// browser.click/fill/press: one act step on a target.
    Step(&'static str),
    FlowStart,
    FlowObserve,
    FlowAct,
    FlowFinish,
    AgentDone,
    Forward {
        tab_id_envelope: bool,
    },
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
        meta.insert(
            "bro/default".to_string(),
            json!(matches!(
                self.name,
                "browser.open"
                    | "browser.observe"
                    | "browser.click"
                    | "browser.fill"
                    | "browser.press"
                    | "browser.act"
                    | "browser.close"
                    | "browser.extract"
                    | "browser.current.extract"
                    | "browser.batch.extract"
                    | "browser.batch.flow"
            )),
        );
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
        "onepassword_find_logins" | "login_form_inspect" | "onepassword_fill_login" => {
            Some("login")
        }
        "frames_list" => Some("frames"),
        "debugger_diagnose" | "extensions_status" | "extensions_pause" | "extensions_resume" => {
            Some("extensions")
        }
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
        | "browser.flow.finish" => Some("compatibility"),
        "browser.open" | "browser.observe" | "browser.click" | "browser.fill" | "browser.press"
        | "browser.act" | "browser.close" => Some("interaction"),
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
        description: "Open several URLs in owned background tabs, run the same steps on each, and close them. Prefer it to open/act when every page needs the same interaction.",
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
        name: "browser.open",
        description: "Open one URL in an owned background tab for interaction and return targetId as soon as it starts loading; the first observe/act waits up to 4 s for the page to load. Close it when done.",
        route: ToolRoute::Open,
        schema: "browser_open",
    },
    ToolSpec {
        name: "browser.observe",
        description: "Read a target. Read content with mode text; use a11y (default) only to find short refs (e.g. kqx12) to act on, across frames and Shadow DOM. Scope with refId; bound with filter/depth/maxChars; continue truncated output with cursor. Refs survive rereads, not navigation.",
        route: ToolRoute::Observe,
        schema: "browser_observe",
    },
    ToolSpec {
        name: "browser.click",
        description: "Click an element by refId (from observe or a change report) or role + name. Waits for the page to settle and reports what visibly changed; a menu or dialog it opens lists its controls' refs, so click those next without observing. \"no visible change\" means it likely missed. targetId defaults to the target this session last used.",
        route: ToolRoute::Step("click"),
        schema: "browser_click",
    },
    ToolSpec {
        name: "browser.fill",
        description: "Set a text field, select, or date/time input by refId or role + name; date inputs take ISO values such as 2026-12-15. Reports what visibly changed. targetId defaults to the target this session last used.",
        route: ToolRoute::Step("fill"),
        schema: "browser_fill",
    },
    ToolSpec {
        name: "browser.press",
        description: "Press a key such as Escape (closes most menus, dialogs and pickers), Enter, Tab or ArrowDown. Goes to the focused element, or focuses refId / role + name first. Reports what visibly changed. targetId defaults to the target this session last used.",
        route: ToolRoute::Step("press"),
        schema: "browser_press",
    },
    ToolSpec {
        name: "browser.act",
        description: "Run 1–32 ordered steps on a target: navigate, evaluate, wait, observe, and click/fill/select/check/scroll. Target elements by refId, or by role + name (e.g. {type:click, role:menuitem, name:\"Read and write\"}), which resolves when the step runs and survives re-renders. Each click/fill/select/check waits for the page to settle and reports what visibly changed (opened/closed dialogs and menus, alerts, new text, navigation, including a form post it started); a click that opens a menu or dialog lists refs for its controls, so act on them without observing. \"no visible change\" means it likely missed. So chain the next steps directly: no delays and no evaluate to read the page back. Use wait only for content that arrives later. All steps validate before any effect; the first failure stops the rest. Prefer these trusted actions over evaluate, whose synthetic events frameworks like React can ignore. Covered clicks fail and name the covering element; check sets a native radio/checkbox without a pointer click. scroll moves the ref's nearest scrollable container, else the page.",
        route: ToolRoute::Act,
        schema: "browser_act",
    },
    ToolSpec {
        name: "browser.close",
        description: "Close an owned target's tab and release its server state. Does not close unrelated tabs. Failed cleanup remains available for an explicit retry.",
        route: ToolRoute::Close,
        schema: "browser_close",
    },
    ToolSpec {
        name: "browser.flow.start",
        description: "Start a default background browser flow for one URL and keep its tab in server memory. Defaults: active false, cleanup true.",
        route: ToolRoute::FlowStart,
        schema: "browser_flow_start",
    },
    ToolSpec {
        name: "browser.flow.observe",
        description: "Observe a flow as a compact accessibility snapshot by default, including iframe and Shadow DOM controls with actionable refs. Same-node refs survive rereads; refId scopes to its document subtree. filter/depth/maxChars/compact bound a11y output and are rejected in text mode. Use mode text only for plain main-frame text.",
        route: ToolRoute::FlowObserve,
        schema: "browser_flow_observe",
    },
    ToolSpec {
        name: "browser.flow.act",
        description: "Run ordered steps on the owned tab. click/fill/select accept snapshot refId or css; scroll requires refId and optionally direction/amount (CSS pixels). Ref click/scroll temporarily emulate page focus without activating the tab/window; scrolling waits for rendering. Combine scroll and read_text steps to verify intermediate UI states in one call; read_text does not replace refs. Never combine refId with css/frameId. Eval is an awaited expression. Stops at the first failed step.",
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
        description: "Explicitly activate a tab and focus its window. Changes user focus; reserve for tasks that genuinely need the foreground, not routine input or retries.",
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
        "Interact with the browser by screenshot, click, type, scroll, drag, or key input. Input temporarily emulates page focus without activating the tab/window, then restores it. No automatic foreground fallback or input replay. Use tabs_activate only when real foreground interaction is necessary.",
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
        "Read a browser-native accessibility snapshot with inline frame trees and Shadow DOM labels. Refs are opaque, bound to tab/frame/document/node, and stable across read_page/find/a11y rereads until document change, node replacement, restart or bounded retention expiry. Reobserve after navigation or DOM replacement; never guess refs.",
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
    ToolSpec {
        name: "onepassword_find_logins",
        description: "Search 1Password Login metadata locally through op CLI, matching like 1Password's default: same scheme/port on the same registrable domain (Public Suffix List), so a secure.example.com login is found from www.example.com. Requires user-authorized confirmMetadataSearch. Optional vault/account scope; unmatched metadata is not returned and no credential fields are read. Returns itemId/vaultId/title/username candidates with match exact-origin|same-site, exact first; pick by username when the user names an account. Zero candidates means nothing can be filled here: never work around it with raw op, title search or 1Password UI automation. Multiple candidates require explicit selection; no substring or cross-site SSO matching.",
        route: ToolRoute::FindLogins,
        schema: "onepassword_find_logins",
    },
    ToolSpec {
        name: "login_form_inspect",
        description: "Inspect main-frame login inputs without CDP or reading field values. Returns fillable fields, hiddenFields, accountSwitchers (remembered-account select/\"other user\" controls with css/optionValue, never their text) and a hint when only a password is fillable, plus origin/documentId/formToken for onepassword_fill_login, valid for 120 seconds. Act on accountSwitchers and inspect again instead of debugging the DOM. Can work while a password-manager iframe blocks CDP; does not require pausing it. No iframe, Shadow DOM or passkey support. Pin browserId/tabId. Never treat controls as account-selection evidence.",
        route: ToolRoute::InspectLogin,
        schema: "login_form_inspect",
    },
    ToolSpec {
        name: "onepassword_fill_login",
        description: "Read only the explicitly selected 1Password Login via local op CLI and privately fill selected empty main-frame input indices. Requires confirmFill for this login/origin. Credentials are not public tool arguments/results. Verify a saved website on the same site (see onepassword_find_logins) and fresh document/form token; refuse changed forms, nonempty fields, OTP/new-password targets. No submit, automatic refresh, extension pause or replay. The destination page can read/react to values; avoid subsequent value reads or secret-bearing capture. Use native UI for passkeys/MFA. If the result is uncertain, inspect navigation without replaying.",
        route: ToolRoute::FillLogin,
        schema: "onepassword_fill_login",
    },
    forward(
        "debugger_diagnose",
        "Diagnose CDP attach failures / CDP_FOREIGN_EXTENSION without CDP. Inspect best-effort frame origins and foreign extension IDs. Empty inventory does not rule out blockers or identify a culprit. Does not read page contents. Frame IDs here are webNavigation IDs, not CDP frame refs.",
        "frames_list",
    ),
    ToolSpec {
        name: "extensions_status",
        description: "Inspect installed extension IDs, enabled state and outstanding profile-wide pause/recovery without CDP. Use after CDP_FOREIGN_EXTENSION; installed does not mean responsible. If login needs a password manager, keep it enabled and complete login through the user or authorized native UI before retrying bro.",
        route: ToolRoute::Forward { tab_id_envelope: false },
        schema: "extensions_status",
    },
    ToolSpec {
        name: "extensions_pause",
        description: "Explicitly pause one user-approved extension across the ENTIRE browser profile for 30–900 seconds. Requires confirmProfileWide=true. Never use automatically on attach errors. Returns ownership token for extensions_resume. Only one outstanding pause is allowed. No refresh or input replay. Automatic restoration can require user intervention; verify extensions_status afterward.",
        route: ToolRoute::Forward { tab_id_envelope: false },
        schema: "extensions_pause",
    },
    ToolSpec {
        name: "extensions_resume",
        description: "Restore the extension disabled by a specific pause using its resumeToken. Verify enabled state before clearing recovery record. If blocked, manually enable in chrome://extensions then call again. Does not enable unrelated extensions.",
        route: ToolRoute::Forward { tab_id_envelope: false },
        schema: "extensions_resume",
    },
    forward(
        "javascript_tool",
        "Execute JavaScript in the page context, optionally targeting a frameId from frames_list.",
        "javascript_tool",
    ),
    forward(
        "form_input",
        "Set and verify a form control value using an opaque ref from an observation, including iframe/Shadow DOM controls. For selects accept an option value or unique visible label. Disabled, read-only, hidden and stale controls fail.",
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
    forward("click_element", "Dispatch a trusted click to the exact snapshot ref, including frame/Shadow DOM targets. Temporarily emulates page focus without activating the tab/window. Covered, disabled or stale targets fail; observe the application result after dispatch.", "ref_id"),
    forward(
        "scroll_element",
        "Scroll an exact snapshot ref by CSS pixels. Temporarily emulates page focus without activating the tab/window, then waits for rendering/scroll handlers. Returns before/after offsets, delta, extent, moved and boundary (null for unsupported writing modes). Does not synthesize events or retry. Use flow.act scroll + read_text for multi-step UI verification.",
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
                json!({"type":"array","items":{"type":"string","format":"uri"},"minItems":1}),
            ),
            (
                "inputs",
                json!({"type":"array","minItems":1,"items":{"type":"object","required":["url"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"description":"Optional caller-supplied result id. Defaults to input-<n>."},"url":{"type":"string","format":"uri"}}}}),
            ),
            (
                "steps",
                flow_steps_schema("Steps run on each new tab; refs are not available.", false),
            ),
            (
                "concurrency",
                json!({"type":"integer","minimum":1,"maximum":16,"default":6}),
            ),
            (
                "timeoutMs",
                json!({"type":"integer","minimum":1,"maximum":60000,"default":12000,"description":"Per URL, including open and steps."}),
            ),
            ("cleanup", json!({"type":"boolean","default":true})),
            ("active", json!({"type":"boolean","default":false})),
            ("browserId", browser_id_schema()),
        ]),
        "browser_open" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            ("browserId", browser_id_schema()),
            ("active", json!({"type":"boolean","default":false})),
            ("ownerSessionId", json!({"type":"string","minLength":1,"description":"Owner identity; Pi supplies it."})),
            ("label", json!({"type":"string","minLength":1,"description":"Tab-group label; Pi supplies it."})),
        ]),
        "browser_observe" => {
            let mut properties = observation_properties();
            properties.insert("targetId".to_string(), target_id_schema());
            properties
        }
        "browser_act" => props(&[
            ("targetId", target_id_schema()),
            ("steps", interaction_steps_schema()),
        ]),
        "browser_click" => with_target(element_target()),
        "browser_fill" => {
            let mut properties = element_target();
            properties.insert(
                "value".to_string(),
                json!({"type":"string","description":"Text, option value or label, or ISO date/time."}),
            );
            with_target(properties)
        }
        "browser_press" => with_target(press_properties()),
        "browser_close" => props(&[("targetId", json!({"type":"string","minLength":1}))]),
        "browser_flow_start" => props(&[
            ("url", json!({"type":"string","format":"uri"})),
            ("browserId", browser_id_schema()),
            ("active", json!({"type":"boolean","default":false})),
            ("cleanup", json!({"type":"boolean","default":true})),
        ]),
        "browser_flow_observe" => {
            let mut properties = observation_properties();
            properties.insert(
                "maxChars".to_string(),
                json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
            );
            properties.insert("sessionId".to_string(), json!({"type":"string","minLength":1}));
            properties
        }
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
            ("maxChars", json!({"type":"integer","minimum":1,"maximum":60000,"default":8000})),
            ("cursor", json!({"type":"integer","minimum":0,"maximum":1000000,"description":"Continue a truncated read from its reported cursor."})),
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
        "onepassword_find_logins" => props(&[
            ("url", json!({"type":"string","format":"uri","description":"Page URL (HTTPS; HTTP only on literal loopback hosts). Matched by registrable domain; loopback/IP hosts only exactly."})),
            ("vault", json!({"type":"string","minLength":1,"description":"Optional vault name/ID to narrow local metadata search."})),
            ("account", json!({"type":"string","minLength":1})),
            ("confirmMetadataSearch", json!({"type":"boolean","const":true})),
        ]),
        "login_form_inspect" => props(&[
            ("browserId", browser_id_schema()),
            ("tabId", tab_id_schema("Explicit login tab ID.")),
        ]),
        "onepassword_fill_login" => props(&[
            ("browserId", browser_id_schema()),
            ("tabId", tab_id_schema("Explicit login tab ID.")),
            ("documentId", json!({"type":"string","minLength":1})),
            ("formToken", json!({"type":"string","minLength":1})),
            ("expectedOrigin", json!({"type":"string","description":"Canonical page origin from login_form_inspect."})),
            ("itemId", json!({"type":"string","pattern":"^[a-z0-9]{26}$"})),
            ("vaultId", json!({"type":"string","pattern":"^[a-z0-9]{26}$"})),
            ("account", json!({"type":"string","minLength":1})),
            ("usernameIndex", json!({"type":"integer","minimum":0})),
            ("passwordIndex", json!({"type":"integer","minimum":0})),
            ("confirmFill", json!({"type":"boolean","const":true})),
        ]),
        "extensions_status" => props(&[("browserId", browser_id_schema())]),
        "extensions_pause" => props(&[
            ("browserId", browser_id_schema()),
            ("extensionId", json!({"type":"string","pattern":"^[a-p]{32}$"})),
            ("confirmProfileWide", json!({"type":"boolean","const":true})),
            ("durationSeconds", json!({"type":"integer","minimum":30,"maximum":900,"default":300})),
        ]),
        "extensions_resume" => props(&[
            ("browserId", browser_id_schema()),
            ("resumeToken", json!({"type":"string","minLength":1})),
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
            ("checked", json!({"type":"boolean","description":"Instead of value: set a native radio/checkbox through its activation behavior."})),
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
        "onepassword_find_logins" => Some(&["url", "confirmMetadataSearch"]),
        "login_form_inspect" => Some(&["browserId", "tabId"]),
        "onepassword_fill_login" => Some(&[
            "browserId",
            "tabId",
            "documentId",
            "formToken",
            "expectedOrigin",
            "itemId",
            "vaultId",
            "confirmFill",
        ]),
        "extensions_pause" => Some(&["extensionId", "confirmProfileWide"]),
        "extensions_resume" => Some(&["resumeToken"]),
        "agent_done" => Some(&["tabIds"]),
        "browser_extract" => Some(&["url"]),
        "browser_console_capture" | "browser_network_capture" => Some(&["url", "code"]),
        "browser_batch_flow" => Some(&["steps"]),
        "browser_open" | "browser_flow_start" => Some(&["url"]),
        "browser_close" => Some(&["targetId"]),
        "browser_act" => Some(&["steps"]),
        "browser_fill" => Some(&["value"]),
        "browser_press" => Some(&["key"]),
        "browser_flow_observe" | "browser_flow_finish" => Some(&["sessionId"]),
        "browser_flow_act" => Some(&["sessionId", "steps"]),
        _ => None,
    }
}

fn observation_properties() -> Map<String, Value> {
    props(&[
        (
            "mode",
            json!({"type":"string","enum":["text","a11y"],"default":"a11y","description":"text: plain main-frame text (default 12000 chars); refId/filter/depth/compact are a11y only."}),
        ),
        (
            "refId",
            json!({"type":"string","minLength":1,"description":"Scope to this ref's subtree."}),
        ),
        (
            "filter",
            json!({"type":"string","enum":["all","interactive"],"default":"all"}),
        ),
        (
            "depth",
            json!({"type":"integer","minimum":1,"maximum":100,"default":20}),
        ),
        (
            "maxChars",
            json!({"type":"integer","minimum":1,"maximum":20000,"default":8000,"description":"a11y caps at 12000; 3000 inside act."}),
        ),
        (
            "cursor",
            json!({"type":"integer","minimum":0,"maximum":1000000,"description":"Continue truncated output."}),
        ),
        (
            "compact",
            json!({"type":"boolean","default":true,"description":"Omit unnamed structural nodes."}),
        ),
    ])
}

fn target_id_schema() -> Value {
    json!({"type":"string","minLength":1,"description":"From browser.open. Defaults to the target this session last opened or used."})
}

fn with_target(mut properties: Map<String, Value>) -> Map<String, Value> {
    properties.insert("targetId".to_string(), target_id_schema());
    properties
}

/// Element steps take refId, or role + name resolved when the step runs.
fn element_target() -> Map<String, Value> {
    props(&[
        (
            "refId",
            json!({"type":"string","minLength":1,"description":"Ref from observe or a change report. Or give role + name instead."}),
        ),
        (
            "role",
            json!({"type":"string","minLength":1,"description":"Accessible role as observe prints it, e.g. button, menuitem, option, textbox. Main frame only."}),
        ),
        (
            "name",
            json!({"type":"string","minLength":1,"description":"Accessible name: exact, else a unique substring. Ambiguous or missing fails."}),
        ),
    ])
}

fn press_properties() -> Map<String, Value> {
    let mut properties = element_target();
    properties.insert(
        "key".to_string(),
        json!({"type":"string","minLength":1,"description":"Key name such as Escape, Enter, Tab, ArrowDown, or a combo like Shift+Tab. Goes to the focused element; a refId or role + name is focused first."}),
    );
    properties
}

fn interaction_steps_schema() -> Value {
    let step = |kind: &str, required: &[&str], mut properties: Map<String, Value>| {
        properties.insert("type".to_string(), json!({"const":kind,"type":"string"}));
        let required: Vec<_> = std::iter::once("type")
            .chain(required.iter().copied())
            .collect();
        json!({"type":"object","required":required,"additionalProperties":false,"properties":properties})
    };
    let ref_target = || props(&[("refId", json!({"type":"string","minLength":1}))]);
    let element = element_target;
    let mut form = element();
    form.insert("value".to_string(), json!({"type":"string"}));
    let mut check = element();
    check.insert(
        "checked".to_string(),
        json!({"type":"boolean","default":true,"description":"Native radio/checkbox; no pointer click, so overlays do not block it."}),
    );
    let press = press_properties();
    let mut scroll = ref_target();
    scroll.insert(
        "direction".to_string(),
        json!({"type":"string","enum":["up","down","left","right"],"default":"down"}),
    );
    scroll.insert(
        "amount".to_string(),
        json!({"type":"integer","minimum":1,"maximum":10000,"default":400}),
    );
    json!({"type":"array","minItems":1,"maxItems":32,"items":{"oneOf":[
        step("navigate", &["url"], props(&[("url", json!({"type":"string","format":"uri"}))])),
        step("evaluate", &["code"], props(&[("code", json!({"type":"string","minLength":1,"description":"Awaited JavaScript expression; IIFE for statements."})),("frameId",json!({"type":"string","minLength":1}))])),
        step("click", &[], element()),
        step("fill", &["value"], form.clone()),
        step("select", &["value"], form),
        step("check", &[], check),
        step("press", &["key"], press),
        step("scroll", &["refId"], scroll),
        step("wait", &[], props(&[
            ("text", json!({"type":"string","minLength":1,"description":"Exactly one condition: text appears, textGone disappears, or refId reaches state."})),
            ("textGone", json!({"type":"string","minLength":1})),
            ("refId", json!({"type":"string","minLength":1})),
            ("state", json!({"type":"string","enum":["visible","hidden","enabled","disabled"]})),
            ("timeoutMs", json!({"type":"integer","minimum":1,"maximum":15000,"default":5000,"description":"Not met in time is reported; later steps still run."})),
        ])),
        step("observe", &[], bare(observation_properties()))
    ]}})
}

/// `allow_refs` is the legacy flow.act schema (goto/eval names, refs); without
/// refs it is batch.flow, which speaks act's names and accepts goto/eval aliases.
fn flow_steps_schema(description: &str, allow_refs: bool) -> Value {
    let companions = if allow_refs {
        "Required companion fields: goto=url, eval=code, click=one of refId/css, fill/select=one of refId/css+value, scroll=refId (direction down, amount 400 CSS pixels by default), wait=ms. read_text reads visible main-frame text without invalidating refs. refId cannot be combined with css/frameId."
    } else {
        "Required fields: navigate=url, evaluate=code, click=css, fill/select=css+value, wait=ms; read_text has none. Same names as browser.act."
    };
    let (navigate, evaluate) = if allow_refs {
        ("goto", "eval")
    } else {
        ("navigate", "evaluate")
    };
    let mut operations = vec![
        navigate,
        evaluate,
        "click",
        "fill",
        "select",
        "wait",
        "read_text",
        "observe",
    ];
    if allow_refs {
        operations.push("scroll");
    }
    let mut properties = props(&[
        (
            "type",
            json!({"type":"string","enum":operations,"description":companions}),
        ),
        ("url", json!({"type":"string","format":"uri"})),
        (
            "code",
            json!({"type":"string","minLength":1,"description":format!("Awaited JavaScript expression for {evaluate}; IIFE for statements.")}),
        ),
        (
            "css",
            json!({"type":"string","minLength":1,"description":"CSS selector for click/fill/select."}),
        ),
        (
            "frameId",
            json!({"type":"string","minLength":1,"description":format!("Frame for {evaluate}, CSS steps or read_text; omit for the main frame.")}),
        ),
        (
            "value",
            json!({"type":"string","description":"Text for fill; option value (or unique label with refId) for select."}),
        ),
        ("ms", json!({"type":"integer","minimum":0,"maximum":30000})),
    ]);
    if allow_refs {
        properties.insert("refId".to_string(), json!({"type":"string","minLength":1,"description":"Opaque document-bound ref for click/fill/select/scroll. Identifies its frame. Do not combine with css/frameId. Same-node refs survive rereads, not navigation/replacement/restart/retention expiry."}));
        properties.insert("direction".to_string(), json!({"type":"string","enum":["up","down","left","right"],"default":"down","description":"Direction for scroll."}));
        properties.insert("amount".to_string(), json!({"type":"integer","minimum":1,"maximum":10000,"default":400,"description":"CSS pixels for scroll; movement is clamped by the actual scroll range."}));
    }
    for (key, value) in bare(observation_properties()) {
        if key != "refId" && key != "cursor" {
            properties.insert(key, value);
        }
    }
    if allow_refs {
        // Legacy flow.act keeps its 1.3 budget; the facade ceilings do not apply.
        properties.insert(
            "maxChars".to_string(),
            json!({"type":"integer","minimum":1,"maximum":60000,"default":8000}),
        );
    }
    json!({"type":"array","minItems":1,"description":description,"items":{"type":"object","required":["type"],"additionalProperties":false,"properties":properties}})
}

/// Nested copies of documented properties (act's observe step) drop the
/// descriptions; the standalone tool already carries them.
fn bare(mut properties: Map<String, Value>) -> Map<String, Value> {
    for value in properties.values_mut() {
        value
            .as_object_mut()
            .expect("schema properties are objects")
            .remove("description");
    }
    properties
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
    fn login_routes_are_server_owned_and_do_not_expose_plaintext_handlers_or_fields() {
        assert_eq!(
            route_for("onepassword_find_logins"),
            Some(ToolRoute::FindLogins)
        );
        assert_eq!(
            route_for("login_form_inspect"),
            Some(ToolRoute::InspectLogin)
        );
        assert_eq!(
            route_for("onepassword_fill_login"),
            Some(ToolRoute::FillLogin)
        );
        assert_eq!(route_for("__bro_login_fill"), None);
        assert_eq!(route_for("__bro_login_inspect"), None);
        let schema = schema("onepassword_fill_login");
        assert!(schema["properties"].get("password").is_none());
        assert!(schema["properties"].get("username").is_none());
        assert_eq!(schema["properties"]["confirmFill"]["const"], true);
    }

    #[test]
    fn target_catalog_is_server_owned_and_observations_share_one_schema() {
        for name in [
            "browser.open",
            "browser.observe",
            "browser.click",
            "browser.fill",
            "browser.press",
            "browser.act",
            "browser.close",
        ] {
            let tool = find_tool(name).unwrap();
            let meta = tool.meta.unwrap();
            assert_eq!(meta.0["bro/default"], true);
            assert_eq!(meta.0["bro/capability"], "interaction");
        }
        assert_eq!(
            find_tool("browser.flow.start").unwrap().meta.unwrap().0["bro/default"],
            false
        );
        // The MCP session supplies its last target when targetId is omitted.
        let observe = schema("browser_observe");
        assert!(observe.get("required").is_none());
        assert_eq!(schema("browser_act")["required"], json!(["steps"]));
        assert_eq!(schema("browser_close")["required"], json!(["targetId"]));
        assert_eq!(route_for("browser.press"), Some(ToolRoute::Step("press")));
        let press = schema("browser_press");
        assert_eq!(press["required"], json!(["key"]));
        assert_eq!(press["properties"]["role"], super::element_target()["role"]);
        assert_eq!(schema("browser_fill")["required"], json!(["value"]));
        assert!(observe["properties"].get("sessionId").is_none());
        for (key, value) in super::observation_properties() {
            assert_eq!(observe["properties"][&key], value);
            if key != "maxChars" {
                assert_eq!(schema("browser_flow_observe")["properties"][&key], value);
            }
        }
        // Facade ceiling; legacy flow.observe keeps its 1.3 bound.
        assert_eq!(observe["properties"]["maxChars"]["maximum"], 20000);
        assert_eq!(
            schema("browser_flow_observe")["properties"]["maxChars"]["maximum"],
            60000
        );
        let act = schema("browser_act");
        assert_eq!(act["properties"]["steps"]["maxItems"], 32);
        let steps = act["properties"]["steps"]["items"]["oneOf"]
            .as_array()
            .unwrap();
        assert_eq!(steps.len(), 10);
        let wait = steps
            .iter()
            .find(|step| step["properties"]["type"]["const"] == "wait")
            .unwrap();
        assert_eq!(wait["required"], json!(["type"]));
        assert!(wait["properties"].get("ms").is_none());
        assert_eq!(
            wait["properties"]["state"]["enum"],
            json!(["visible", "hidden", "enabled", "disabled"])
        );
        assert_eq!(wait["properties"]["timeoutMs"]["maximum"], 15000);
        assert_eq!(wait["properties"]["timeoutMs"]["default"], 5000);
        let click = steps
            .iter()
            .find(|step| step["properties"]["type"]["const"] == "click")
            .unwrap();
        assert_eq!(click["required"], json!(["type"]));
        assert_eq!(click["properties"]["role"]["type"], "string");
        assert!(click["properties"].get("css").is_none());
        let check = steps
            .iter()
            .find(|step| step["properties"]["type"]["const"] == "check")
            .unwrap();
        assert_eq!(check["required"], json!(["type"]));
        assert_eq!(check["properties"]["checked"]["default"], true);
        assert_eq!(observe["properties"]["maxChars"]["default"], 8000);

        // batch.flow speaks act's step names; legacy flow.act keeps goto/eval.
        let batch = schema("browser_batch_flow");
        let names = &batch["properties"]["steps"]["items"]["properties"]["type"]["enum"];
        assert_eq!(names[0], "navigate");
        assert_eq!(names[1], "evaluate");
        assert!(!names.as_array().unwrap().contains(&json!("goto")));
        let legacy = schema("browser_flow_act");
        assert_eq!(
            legacy["properties"]["steps"]["items"]["properties"]["type"]["enum"][0],
            "goto"
        );
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
