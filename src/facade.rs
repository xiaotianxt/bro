use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::{
    sync::{Mutex, Semaphore},
    task::JoinSet,
    time,
};
use uuid::Uuid;

use crate::bridge::{BridgeError, BridgeToolResult, BrowserBridge};

const DEFAULT_BATCH_CONCURRENCY: usize = 6;
const MAX_BATCH_CONCURRENCY: usize = 16;
const DEFAULT_TIMEOUT_MS: u64 = 12_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_TEXT_READY_TIMEOUT_MS: u64 = 4_000;
const DEFAULT_TEXT_READY_MIN_CHARS: usize = 120;
const MAX_TEXT_READY_MIN_CHARS: usize = 10_000;
const EXTRACT_PAGE_GUARD_MS: u64 = 8_000;
const DEFAULT_EXTRACT_MAX_CHARS: u64 = 8_000;
const MAX_EXTRACT_MAX_CHARS: u64 = 60_000;
const DEFAULT_EXTRACT_MAX_LINKS: u64 = 20;
const MAX_EXTRACT_MAX_LINKS: u64 = 200;
const TEXT_READY_POLL_MS: u64 = 250;
const MAX_WAIT_MS: u64 = 30_000;
const CLEANUP_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Error)]
pub enum FacadeError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("unknown flow session: {0}")]
    UnknownSession(String),
    #[error("browser tool {tool} failed: {message}")]
    ToolFailed { tool: &'static str, message: String },
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct BrowserFacade {
    bridge: BrowserBridge,
    sessions: Arc<Mutex<HashMap<String, FlowSession>>>,
}

impl BrowserFacade {
    pub fn new(bridge: BrowserBridge) -> Self {
        Self {
            bridge,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn batch_run(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = BatchRunArgs::parse(args)?;
        let concurrency = args.concurrency;
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let mut tasks = JoinSet::new();

        for (index, input) in args.inputs.into_iter().enumerate() {
            let facade = self.clone();
            let options = args.options.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let Ok(permit) = semaphore.acquire_owned().await else {
                    return (
                        index,
                        BatchItemResult::failed(input, None, "batch scheduler closed"),
                    );
                };
                let _permit = permit;
                let result = facade.run_batch_item(input, options).await;
                (index, result)
            });
        }

        let mut results = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(result) => results.push(result),
                Err(error) => results.push((
                    usize::MAX,
                    BatchItemResult::failed(
                        BatchInput {
                            id: "unknown".to_string(),
                            url: String::new(),
                        },
                        None,
                        format!("batch task failed: {error}"),
                    ),
                )),
            }
        }
        results.sort_by_key(|(index, _result)| *index);

        Ok(json!({
            "results": results
                .into_iter()
                .map(|(_index, result)| result)
                .collect::<Vec<_>>()
        }))
    }

    pub async fn batch_flow(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = BatchFlowArgs::parse(args)?;
        let concurrency = args.concurrency;
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let mut tasks = JoinSet::new();

        for (index, input) in args.inputs.into_iter().enumerate() {
            let facade = self.clone();
            let steps = args.steps.clone();
            let options = args.options.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let Ok(permit) = semaphore.acquire_owned().await else {
                    return (
                        index,
                        BatchFlowItemResult::failed(input, None, "batch flow scheduler closed"),
                    );
                };
                let _permit = permit;
                let result = facade.run_batch_flow_item(input, steps, options).await;
                (index, result)
            });
        }

        let mut results = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(result) => results.push(result),
                Err(error) => results.push((
                    usize::MAX,
                    BatchFlowItemResult::failed(
                        BatchInput {
                            id: "unknown".to_string(),
                            url: String::new(),
                        },
                        None,
                        format!("batch flow task failed: {error}"),
                    ),
                )),
            }
        }
        results.sort_by_key(|(index, _result)| *index);

        Ok(json!({
            "results": results
                .into_iter()
                .map(|(_index, result)| result)
                .collect::<Vec<_>>()
        }))
    }

    pub async fn extract(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = ExtractArgs::parse(args)?;
        let result = self.run_extract_item(args.input, args.options).await;
        Ok(json!(result))
    }

    pub async fn current_extract(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = CurrentExtractArgs::parse(args)?;
        let result = self.extract_current_tab(args.id, args.options).await;
        Ok(json!(result))
    }

    pub async fn batch_extract(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = BatchExtractArgs::parse(args)?;
        let concurrency = args.concurrency;
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let mut tasks = JoinSet::new();

        for (index, input) in args.inputs.into_iter().enumerate() {
            let facade = self.clone();
            let options = args.options.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let Ok(permit) = semaphore.acquire_owned().await else {
                    return (
                        index,
                        ExtractItemResult::failed(input, None, "extract scheduler closed"),
                    );
                };
                let _permit = permit;
                let result = facade.run_extract_item(input, options).await;
                (index, result)
            });
        }

        let mut results = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(result) => results.push(result),
                Err(error) => results.push((
                    usize::MAX,
                    ExtractItemResult::failed(
                        BatchInput {
                            id: "unknown".to_string(),
                            url: String::new(),
                        },
                        None,
                        format!("extract task failed: {error}"),
                    ),
                )),
            }
        }
        results.sort_by_key(|(index, _result)| *index);

        Ok(json!({
            "results": results
                .into_iter()
                .map(|(_index, result)| result)
                .collect::<Vec<_>>()
        }))
    }

    pub async fn console_capture(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<ConsoleCaptureArgs>(args)?;
        let create = self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": args.url.clone(), "active": args.active }),
                None,
                args.browser_id.clone(),
            )
            .await?;
        fail_if_tool_error("tabs_create", &create)?;
        let tab_id = extract_tab_id(&create.result).ok_or_else(|| FacadeError::ToolFailed {
            tool: "tabs_create",
            message: "response did not include tabId".to_string(),
        })?;
        let session = FlowSession {
            session_id: format!("console-capture-{}", Uuid::new_v4()),
            tab_id,
            browser_id: args.browser_id.clone(),
            url: args.url.clone(),
            cleanup: args.cleanup,
        };

        let outcome = async {
            let ready = self
                .read_text_with_retry(tab_id, args.browser_id.clone())
                .await?;
            fail_if_tool_error("get_page_text", &ready)?;
            let capture = self
                .bridge
                .dispatch(
                    "capture_console",
                    json!({
                        "code": args.code,
                        "timeoutMs": args.timeout_ms.min(20_000),
                        "maxMessages": args.max_messages.min(500)
                    }),
                    Some(tab_id),
                    args.browser_id.clone(),
                )
                .await?;
            fail_if_tool_error("capture_console", &capture)?;
            parse_capture_json(
                "capture_console",
                &capture.result,
                tab_id,
                &args.url,
                args.browser_id.as_deref(),
            )
        }
        .await;

        let cleanup_error = if args.cleanup {
            self.close_tab(&session).await.err()
        } else {
            None
        };
        finish_capture("capture_console", outcome, cleanup_error)
    }

    pub async fn network_capture(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<NetworkCaptureArgs>(args)?;
        let create = self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": args.url.clone(), "active": args.active }),
                None,
                args.browser_id.clone(),
            )
            .await?;
        fail_if_tool_error("tabs_create", &create)?;
        let tab_id = extract_tab_id(&create.result).ok_or_else(|| FacadeError::ToolFailed {
            tool: "tabs_create",
            message: "response did not include tabId".to_string(),
        })?;
        let session = FlowSession {
            session_id: format!("network-capture-{}", Uuid::new_v4()),
            tab_id,
            browser_id: args.browser_id.clone(),
            url: args.url.clone(),
            cleanup: args.cleanup,
        };

        let outcome = async {
            let ready = self
                .read_text_with_retry(tab_id, args.browser_id.clone())
                .await?;
            fail_if_tool_error("get_page_text", &ready)?;

            let mut capture_args = Map::from_iter([
                ("code".to_string(), json!(args.code.clone())),
                ("timeoutMs".to_string(), json!(args.timeout_ms.min(20_000))),
                (
                    "includeResponseBodies".to_string(),
                    json!(args.include_response_bodies),
                ),
                ("includeHeaders".to_string(), json!(args.include_headers)),
                ("includePostData".to_string(), json!(args.include_post_data)),
                (
                    "maxBodyChars".to_string(),
                    json!(args.max_body_chars.min(60_000)),
                ),
                ("maxRequests".to_string(), json!(args.max_requests.min(100))),
            ]);
            if let Some(url_includes) = &args.url_includes {
                capture_args.insert("urlIncludes".to_string(), json!(url_includes));
            }
            let capture = self
                .bridge
                .dispatch(
                    "capture_network",
                    Value::Object(capture_args),
                    Some(tab_id),
                    args.browser_id.clone(),
                )
                .await?;
            fail_if_tool_error("capture_network", &capture)?;
            parse_capture_json(
                "capture_network",
                &capture.result,
                tab_id,
                &args.url,
                args.browser_id.as_deref(),
            )
        }
        .await;

        let cleanup_error = if args.cleanup {
            self.close_tab(&session).await.err()
        } else {
            None
        };
        finish_capture("capture_network", outcome, cleanup_error)
    }

    pub async fn flow_start(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<FlowStartArgs>(args)?;
        let result = self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": args.url, "active": args.active }),
                None,
                args.browser_id.clone(),
            )
            .await?;
        fail_if_tool_error("tabs_create", &result)?;

        let tab_id = extract_tab_id(&result.result).ok_or_else(|| FacadeError::ToolFailed {
            tool: "tabs_create",
            message: "response did not include tabId".to_string(),
        })?;
        let session_id = new_flow_session_id();
        let session = FlowSession {
            session_id: session_id.clone(),
            tab_id,
            browser_id: args.browser_id,
            url: args.url,
            cleanup: args.cleanup,
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session.clone());

        Ok(session.to_value())
    }

    pub async fn flow_observe(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<FlowObserveArgs>(args)?;
        let session = self.session(&args.session_id).await?;
        let (tool, bridge_result) = match args.mode {
            ObserveMode::Text => {
                let result = self
                    .read_text_with_retry(session.tab_id, session.browser_id.clone())
                    .await?;
                ("get_page_text", result)
            }
            ObserveMode::A11y => {
                let result = self
                    .bridge
                    .dispatch(
                        "read_page",
                        json!({}),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                ("read_page", result)
            }
        };
        fail_if_tool_error(tool, &bridge_result)?;

        let mut value = session.to_value_object();
        value.insert("mode".to_string(), json!(args.mode));
        value.insert(
            "content".to_string(),
            json!(extract_text(&bridge_result.result).unwrap_or_default()),
        );
        Ok(Value::Object(value))
    }

    pub async fn flow_act(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<FlowActArgs>(args)?;
        let session = self.session(&args.session_id).await?;
        let mut step_results = Vec::with_capacity(args.steps.len());
        let mut status = "ok";
        let mut stopped_at = None;

        for (index, step) in args.steps.into_iter().enumerate() {
            let step_type = step.kind();
            let result = self.run_flow_step(&session, step).await;
            match result {
                Ok(mut value) => {
                    value.insert("index".to_string(), json!(index));
                    value.insert("type".to_string(), json!(step_type));
                    value.insert("status".to_string(), json!("ok"));
                    step_results.push(Value::Object(value));
                }
                Err(error) => {
                    status = "failed";
                    stopped_at = Some(index);
                    step_results.push(json!({
                        "index": index,
                        "type": step_type,
                        "status": "failed",
                        "error": error.to_string()
                    }));
                    break;
                }
            }
        }

        let mut value = session.to_value_object();
        value.insert("status".to_string(), json!(status));
        value.insert("stoppedAt".to_string(), json!(stopped_at));
        value.insert("results".to_string(), json!(step_results));
        Ok(Value::Object(value))
    }

    pub async fn flow_finish(&self, args: Map<String, Value>) -> Result<Value, FacadeError> {
        let args = parse_args::<FlowFinishArgs>(args)?;
        let session = self
            .sessions
            .lock()
            .await
            .remove(&args.session_id)
            .ok_or_else(|| FacadeError::UnknownSession(args.session_id.clone()))?;
        let cleanup = args.cleanup.unwrap_or(session.cleanup);
        let mut close_error = None;

        if cleanup {
            match self.close_tab(&session).await {
                Ok(()) => {}
                Err(error) => close_error = Some(error.to_string()),
            }
        }

        let mut value = session.to_value_object();
        value.insert("cleanup".to_string(), json!(cleanup));
        value.insert(
            "closed".to_string(),
            json!(cleanup && close_error.is_none()),
        );
        value.insert(
            "status".to_string(),
            json!(if close_error.is_some() {
                "failed"
            } else {
                "ok"
            }),
        );
        if let Some(error) = close_error {
            value.insert("error".to_string(), json!(error));
        }
        Ok(Value::Object(value))
    }

    async fn run_batch_item(&self, input: BatchInput, options: BatchOptions) -> BatchItemResult {
        let owned_tab = Arc::new(Mutex::new(None));
        match time::timeout(
            Duration::from_millis(options.timeout_ms),
            self.run_batch_item_inner(input.clone(), options.clone(), Arc::clone(&owned_tab)),
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => {
                let cleanup_error = self.cleanup_owned_tab(owned_tab).await;
                let mut result = BatchItemResult::failed(input, None, "operation timed out");
                if let Some(error) = cleanup_error {
                    result.error = Some(format!("operation timed out; cleanup failed: {error}"));
                }
                result
            }
        }
    }

    async fn run_batch_item_inner(
        &self,
        input: BatchInput,
        options: BatchOptions,
        owned_tab: Arc<Mutex<Option<OwnedTab>>>,
    ) -> BatchItemResult {
        let create = match self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": input.url, "active": options.active }),
                None,
                options.browser_id.clone(),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => return BatchItemResult::failed(input, None, error.to_string()),
        };

        if let Some(message) = tool_error_message(&create) {
            return BatchItemResult::failed(input, extract_tab_id(&create.result), message);
        }

        let tab_id = extract_tab_id(&create.result);
        let title = extract_title(&create.result);
        let Some(tab_id_value) = tab_id else {
            return BatchItemResult::failed(
                input,
                None,
                "tabs_create response did not include tabId",
            );
        };
        *owned_tab.lock().await = Some(OwnedTab {
            tab_id: tab_id_value,
            browser_id: options.browser_id.clone(),
            cleanup: options.cleanup,
        });

        let text_result = self
            .read_text_with_retry(tab_id_value, options.browser_id.clone())
            .await;

        let mut result = match text_result {
            Ok(read) => {
                if let Some(message) = tool_error_message(&read) {
                    BatchItemResult::failed(input, tab_id, message)
                } else {
                    BatchItemResult::ok(input, tab_id, title, extract_text(&read.result))
                }
            }
            Err(error) => BatchItemResult::failed(input, tab_id, error.to_string()),
        };

        if options.cleanup {
            if let Err(error) = self
                .bridge
                .dispatch(
                    "tabs_close",
                    json!({ "tabId": tab_id_value }),
                    None,
                    options.browser_id,
                )
                .await
            {
                result.status = BatchStatus::Failed;
                result.error = Some(error.to_string());
            } else {
                *owned_tab.lock().await = None;
            }
        }

        result
    }

    async fn run_batch_flow_item(
        &self,
        input: BatchInput,
        steps: Vec<FlowStep>,
        options: BatchOptions,
    ) -> BatchFlowItemResult {
        let owned_tab = Arc::new(Mutex::new(None));
        match time::timeout(
            Duration::from_millis(options.timeout_ms),
            self.run_batch_flow_item_inner(
                input.clone(),
                steps,
                options.clone(),
                Arc::clone(&owned_tab),
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => {
                let cleanup_error = self.cleanup_owned_tab(owned_tab).await;
                let mut result = BatchFlowItemResult::failed(input, None, "operation timed out");
                if let Some(error) = cleanup_error {
                    result.error = Some(format!("operation timed out; cleanup failed: {error}"));
                }
                result
            }
        }
    }

    async fn run_batch_flow_item_inner(
        &self,
        input: BatchInput,
        steps: Vec<FlowStep>,
        options: BatchOptions,
        owned_tab: Arc<Mutex<Option<OwnedTab>>>,
    ) -> BatchFlowItemResult {
        let create = match self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": input.url, "active": options.active }),
                None,
                options.browser_id.clone(),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => return BatchFlowItemResult::failed(input, None, error.to_string()),
        };

        if let Some(message) = tool_error_message(&create) {
            return BatchFlowItemResult::failed(input, extract_tab_id(&create.result), message);
        }

        let tab_id = extract_tab_id(&create.result);
        let title = extract_title(&create.result);
        let Some(tab_id_value) = tab_id else {
            return BatchFlowItemResult::failed(
                input,
                None,
                "tabs_create response did not include tabId",
            );
        };
        *owned_tab.lock().await = Some(OwnedTab {
            tab_id: tab_id_value,
            browser_id: options.browser_id.clone(),
            cleanup: options.cleanup,
        });

        let session = FlowSession {
            session_id: format!("batch-flow-{}", Uuid::new_v4()),
            tab_id: tab_id_value,
            browser_id: options.browser_id.clone(),
            url: input.url.clone(),
            cleanup: options.cleanup,
        };

        let mut result = BatchFlowItemResult::ok(input, tab_id, title);
        for (index, step) in steps.into_iter().enumerate() {
            let step_type = step.kind();
            match self.run_flow_step(&session, step).await {
                Ok(mut value) => {
                    value.insert("index".to_string(), json!(index));
                    value.insert("type".to_string(), json!(step_type));
                    value.insert("status".to_string(), json!("ok"));
                    result.results.push(Value::Object(value));
                }
                Err(error) => {
                    result.status = BatchStatus::Failed;
                    result.stopped_at = Some(index);
                    result.error = Some(error.to_string());
                    result.results.push(json!({
                        "index": index,
                        "type": step_type,
                        "status": "failed",
                        "error": error.to_string()
                    }));
                    break;
                }
            }
        }

        if let Some(error) = self.cleanup_owned_tab(owned_tab).await {
            result.status = BatchStatus::Failed;
            result.error = Some(match result.error {
                Some(existing) => format!("{existing}; cleanup failed: {error}"),
                None => format!("cleanup failed: {error}"),
            });
        }

        result
    }

    async fn run_extract_item(
        &self,
        input: BatchInput,
        options: ExtractOptions,
    ) -> ExtractItemResult {
        self.run_extract_item_inner(input, options).await
    }

    async fn run_extract_item_inner(
        &self,
        input: BatchInput,
        options: ExtractOptions,
    ) -> ExtractItemResult {
        let create = match self
            .bridge
            .dispatch(
                "tabs_create",
                json!({ "url": input.url, "active": options.active }),
                None,
                options.browser_id.clone(),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => return ExtractItemResult::failed(input, None, error.to_string()),
        };

        if let Some(message) = tool_error_message(&create) {
            return ExtractItemResult::failed(input, extract_tab_id(&create.result), message);
        }

        let tab_id = extract_tab_id(&create.result);
        let title = extract_title(&create.result);
        let Some(tab_id_value) = tab_id else {
            return ExtractItemResult::failed(
                input,
                None,
                "tabs_create response did not include tabId",
            );
        };

        let mut result = self
            .extract_from_tab(input, tab_id_value, title, &options)
            .await;

        if options.cleanup {
            if let Err(error) = self
                .bridge
                .dispatch(
                    "tabs_close",
                    json!({ "tabId": tab_id_value }),
                    None,
                    options.browser_id,
                )
                .await
            {
                result.status = ExtractStatus::Failed;
                result.error = Some(error.to_string());
            }
        }

        result
    }

    async fn extract_from_tab(
        &self,
        input: BatchInput,
        tab_id: i64,
        title: Option<String>,
        options: &ExtractOptions,
    ) -> ExtractItemResult {
        let start = time::Instant::now();
        let initial = self
            .read_extension_extract_page(Some(tab_id), options.browser_id.clone(), options)
            .await;
        let title = title.or_else(|| {
            initial
                .as_ref()
                .ok()
                .and_then(|snapshot| non_empty_string(snapshot.title.clone()))
        });
        self.finish_extract_from_initial(input, Some(tab_id), title, initial, options, start)
            .await
    }

    async fn extract_current_tab(&self, id: String, options: ExtractOptions) -> ExtractItemResult {
        let start = time::Instant::now();
        let snapshot = match self
            .read_extension_extract_page(None, options.browser_id.clone(), &options)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return ExtractItemResult::failed(
                    BatchInput {
                        id,
                        url: "current".to_string(),
                    },
                    None,
                    error.to_string(),
                );
            }
        };
        let tab_id = snapshot.tab_id;
        let title = non_empty_string(snapshot.title.clone());
        let url = non_empty_string(snapshot.url.clone()).unwrap_or_else(|| "current".to_string());
        let input = BatchInput { id, url };
        self.finish_extract_from_initial(input, tab_id, title, Ok(snapshot), &options, start)
            .await
    }

    async fn finish_extract_from_initial(
        &self,
        input: BatchInput,
        tab_id: Option<i64>,
        title: Option<String>,
        initial: Result<DomSnapshot, FacadeError>,
        options: &ExtractOptions,
        start: time::Instant,
    ) -> ExtractItemResult {
        let mut diagnostics = ExtractDiagnostics::default();
        let mut best_text;
        let mut best_source = "extract_page";
        let mut links = Vec::new();

        let mut best_quality = match initial {
            Ok(snapshot) => {
                diagnostics.text_attempts = 1;
                diagnostics.dom_chars = snapshot.text.chars().count();
                diagnostics.dom_attempted = true;
                diagnostics.extension_reason = snapshot.readiness.reason;
                links.extend(snapshot.links);
                best_text = snapshot.text;
                text_quality(&best_text, options.min_chars)
            }
            Err(error) => {
                diagnostics.errors.push(format!("extract_page: {error}"));
                best_text = String::new();
                TextQuality::default()
            }
        };

        if options.include_a11y && !best_quality.ready {
            diagnostics.a11y_attempted = true;
            if let Some(tab_id) = tab_id {
                match self
                    .read_a11y_snapshot(tab_id, options.browser_id.clone(), options.max_chars)
                    .await
                {
                    Ok(snapshot) => {
                        diagnostics.a11y_chars = snapshot.chars().count();
                        links.extend(parse_a11y_links(&snapshot));
                        let quality = text_quality(&snapshot, options.min_chars);
                        if !best_quality.ready && quality.score > best_quality.score {
                            best_text = snapshot;
                            best_quality = quality;
                            best_source = "a11y";
                        }
                    }
                    Err(error) => diagnostics.errors.push(format!("a11y: {error}")),
                }
            } else {
                diagnostics
                    .errors
                    .push("a11y: current tab id unavailable".to_string());
            }
        }

        let needs_dom_fallback = !best_quality.ready;
        if needs_dom_fallback || (options.include_links && links.is_empty()) {
            diagnostics.dom_attempted = true;
            if let Some(tab_id) = tab_id {
                match self
                    .read_dom_snapshot(tab_id, options.browser_id.clone())
                    .await
                {
                    Ok(snapshot) => {
                        diagnostics.dom_chars = snapshot.text.chars().count();
                        links.extend(snapshot.links);
                        let quality = text_quality(&snapshot.text, options.min_chars);
                        if !best_quality.ready && quality.score > best_quality.score {
                            best_text = snapshot.text;
                            best_quality = quality;
                            best_source = "dom";
                        }
                    }
                    Err(error) => diagnostics.errors.push(format!("dom: {error}")),
                }
            } else {
                diagnostics
                    .errors
                    .push("dom: current tab id unavailable".to_string());
            }
        }

        dedupe_links(&mut links);
        let original_text_chars = best_text.chars().count();
        let original_link_count = links.len();
        enforce_extract_limits(&mut best_text, &mut links, options);
        diagnostics.elapsed_ms = start.elapsed().as_millis() as u64;
        diagnostics.text_chars = best_text.chars().count();
        diagnostics.source = best_source.to_string();
        diagnostics.ready = best_quality.ready;
        diagnostics.text_truncated = original_text_chars > options.max_chars as usize;
        diagnostics.links_truncated =
            options.include_links && original_link_count > options.max_links as usize;

        ExtractItemResult::ok(input, tab_id, title, best_text, links, diagnostics)
    }

    async fn read_extension_extract_page(
        &self,
        tab_id: Option<i64>,
        browser_id: Option<String>,
        options: &ExtractOptions,
    ) -> Result<DomSnapshot, FacadeError> {
        let result = self
            .bridge
            .dispatch(
                "extract_page",
                json!({
                    "minChars": options.min_chars,
                    "quietMs": TEXT_READY_POLL_MS,
                    "guardMs": EXTRACT_PAGE_GUARD_MS,
                    "maxChars": options.max_chars,
                    "maxLinks": if options.include_links { options.max_links } else { 0 }
                }),
                tab_id,
                browser_id,
            )
            .await?;
        fail_if_tool_error("extract_page", &result)?;
        parse_dom_snapshot(&result.result)
    }

    async fn read_a11y_snapshot(
        &self,
        tab_id: i64,
        browser_id: Option<String>,
        max_chars: u64,
    ) -> Result<String, FacadeError> {
        let result = self
            .bridge
            .dispatch(
                "read_page",
                json!({ "maxChars": max_chars, "compact": true }),
                Some(tab_id),
                browser_id,
            )
            .await?;
        fail_if_tool_error("read_page", &result)?;
        Ok(extract_text(&result.result).unwrap_or_default())
    }

    async fn read_dom_snapshot(
        &self,
        tab_id: i64,
        browser_id: Option<String>,
    ) -> Result<DomSnapshot, FacadeError> {
        let result = self
            .bridge
            .dispatch(
                "javascript_tool",
                json!({ "code": dom_extract_script() }),
                Some(tab_id),
                browser_id,
            )
            .await?;
        fail_if_tool_error("javascript_tool", &result)?;
        parse_dom_snapshot(&result.result)
    }

    async fn run_flow_step(
        &self,
        session: &FlowSession,
        step: FlowStep,
    ) -> Result<Map<String, Value>, FacadeError> {
        match step {
            FlowStep::Goto { url } => {
                let result = self
                    .bridge
                    .dispatch(
                        "navigate",
                        json!({ "url": url }),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("navigate", &result)?;
                self.update_session_url(&session.session_id, url).await;
                Ok(single_result(result.result))
            }
            FlowStep::Eval { code, frame_id } => {
                let result = self
                    .bridge
                    .dispatch(
                        "javascript_tool",
                        javascript_tool_args(code, true, frame_id),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("javascript_tool", &result)?;
                Ok(single_result(result.result))
            }
            FlowStep::Click { css, frame_id } => {
                let code = click_script(&css)?;
                let result = self
                    .bridge
                    .dispatch(
                        "javascript_tool",
                        javascript_tool_args(code, false, frame_id),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("javascript_tool", &result)?;
                Ok(single_result(result.result))
            }
            FlowStep::Fill {
                css,
                value,
                frame_id,
            } => {
                let code = fill_script(&css, &value)?;
                let result = self
                    .bridge
                    .dispatch(
                        "javascript_tool",
                        javascript_tool_args(code, false, frame_id),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("javascript_tool", &result)?;
                Ok(single_result(result.result))
            }
            FlowStep::Select {
                css,
                value,
                frame_id,
            } => {
                let code = select_script(&css, &value)?;
                let result = self
                    .bridge
                    .dispatch(
                        "javascript_tool",
                        javascript_tool_args(code, false, frame_id),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("javascript_tool", &result)?;
                Ok(single_result(result.result))
            }
            FlowStep::Wait { ms } => {
                let clamped = ms.min(MAX_WAIT_MS);
                time::sleep(Duration::from_millis(clamped)).await;
                Ok(Map::from_iter([("ms".to_string(), json!(clamped))]))
            }
            FlowStep::ReadText { frame_id: None } => {
                let result = self
                    .read_text_with_retry(session.tab_id, session.browser_id.clone())
                    .await?;
                fail_if_tool_error("get_page_text", &result)?;
                Ok(Map::from_iter([(
                    "text".to_string(),
                    json!(extract_text(&result.result).unwrap_or_default()),
                )]))
            }
            FlowStep::ReadText {
                frame_id: Some(frame_id),
            } => {
                let result = self
                    .bridge
                    .dispatch(
                        "javascript_tool",
                        javascript_tool_args(
                            "document.body?.innerText ?? ''".to_string(),
                            true,
                            Some(frame_id),
                        ),
                        Some(session.tab_id),
                        session.browser_id.clone(),
                    )
                    .await?;
                fail_if_tool_error("javascript_tool", &result)?;
                Ok(Map::from_iter([(
                    "text".to_string(),
                    json!(javascript_string_result(&result.result)?),
                )]))
            }
        }
    }

    async fn read_text_with_retry(
        &self,
        tab_id: i64,
        browser_id: Option<String>,
    ) -> Result<BridgeToolResult, BridgeError> {
        let deadline = time::Instant::now() + Duration::from_millis(DEFAULT_TEXT_READY_TIMEOUT_MS);

        loop {
            let result = self
                .bridge
                .dispatch("get_page_text", json!({}), Some(tab_id), browser_id.clone())
                .await?;

            if tool_error_message(&result).is_some()
                || extract_text(&result.result).is_some_and(|text| has_page_text(&text))
                || time::Instant::now() >= deadline
            {
                return Ok(result);
            }

            time::sleep(Duration::from_millis(TEXT_READY_POLL_MS)).await;
        }
    }

    async fn session(&self, session_id: &str) -> Result<FlowSession, FacadeError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| FacadeError::UnknownSession(session_id.to_string()))
    }

    async fn update_session_url(&self, session_id: &str, url: String) {
        if let Some(session) = self.sessions.lock().await.get_mut(session_id) {
            session.url = url;
        }
    }

    async fn close_tab(&self, session: &FlowSession) -> Result<(), FacadeError> {
        let result = self
            .bridge
            .dispatch(
                "tabs_close",
                json!({ "tabId": session.tab_id }),
                None,
                session.browser_id.clone(),
            )
            .await?;
        fail_if_tool_error("tabs_close", &result)
    }

    async fn cleanup_owned_tab(&self, owned_tab: Arc<Mutex<Option<OwnedTab>>>) -> Option<String> {
        let owned = owned_tab.lock().await.take()?;
        if !owned.cleanup {
            return None;
        }

        match time::timeout(
            Duration::from_millis(CLEANUP_TIMEOUT_MS),
            self.bridge.dispatch(
                "tabs_close",
                json!({ "tabId": owned.tab_id }),
                None,
                owned.browser_id,
            ),
        )
        .await
        {
            Ok(Ok(result)) => tool_error_message(&result),
            Ok(Err(error)) => Some(error.to_string()),
            Err(_elapsed) => Some("cleanup timed out".to_string()),
        }
    }
}

#[derive(Debug, Clone)]
struct BatchRunArgs {
    inputs: Vec<BatchInput>,
    concurrency: usize,
    options: BatchOptions,
}

impl BatchRunArgs {
    fn parse(args: Map<String, Value>) -> Result<Self, FacadeError> {
        let raw = parse_args::<RawBatchRunArgs>(args)?;
        let inputs = match (raw.urls, raw.inputs) {
            (Some(urls), None) => urls
                .into_iter()
                .enumerate()
                .map(|(index, url)| BatchInput {
                    id: format!("url-{}", index + 1),
                    url,
                })
                .collect::<Vec<_>>(),
            (None, Some(inputs)) => inputs
                .into_iter()
                .enumerate()
                .map(|(index, mut input)| {
                    if input.id.is_empty() {
                        input.id = format!("input-{}", index + 1);
                    }
                    input
                })
                .collect(),
            (Some(_), Some(_)) => {
                return Err(FacadeError::InvalidInput(
                    "provide either urls or inputs, not both".to_string(),
                ));
            }
            (None, None) => {
                return Err(FacadeError::InvalidInput(
                    "browser.batch.run requires urls or inputs".to_string(),
                ));
            }
        };

        if inputs.is_empty() {
            return Err(FacadeError::InvalidInput(
                "browser.batch.run requires at least one URL".to_string(),
            ));
        }
        if let Some(input) = inputs.iter().find(|input| input.url.is_empty()) {
            return Err(FacadeError::InvalidInput(format!(
                "input {} has an empty url",
                input.id
            )));
        }

        let concurrency = raw
            .concurrency
            .unwrap_or(DEFAULT_BATCH_CONCURRENCY)
            .clamp(1, MAX_BATCH_CONCURRENCY);
        let timeout_ms = raw
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS);

        Ok(Self {
            inputs,
            concurrency,
            options: BatchOptions {
                timeout_ms,
                cleanup: raw.cleanup.unwrap_or(true),
                active: raw.active.unwrap_or(false),
                browser_id: raw.browser_id,
            },
        })
    }
}

#[derive(Debug, Clone)]
struct BatchFlowArgs {
    inputs: Vec<BatchInput>,
    steps: Vec<FlowStep>,
    concurrency: usize,
    options: BatchOptions,
}

impl BatchFlowArgs {
    fn parse(args: Map<String, Value>) -> Result<Self, FacadeError> {
        let raw = parse_args::<RawBatchFlowArgs>(args)?;
        let inputs = parse_batch_inputs(raw.urls, raw.inputs, "browser.batch.flow")?;
        if raw.steps.is_empty() {
            return Err(FacadeError::InvalidInput(
                "browser.batch.flow requires at least one step".to_string(),
            ));
        }
        let concurrency = raw
            .concurrency
            .unwrap_or(DEFAULT_BATCH_CONCURRENCY)
            .clamp(1, MAX_BATCH_CONCURRENCY);
        let timeout_ms = raw
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS);

        Ok(Self {
            inputs,
            steps: raw.steps,
            concurrency,
            options: BatchOptions {
                timeout_ms,
                cleanup: raw.cleanup.unwrap_or(true),
                active: raw.active.unwrap_or(false),
                browser_id: raw.browser_id,
            },
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBatchFlowArgs {
    urls: Option<Vec<String>>,
    inputs: Option<Vec<BatchInput>>,
    steps: Vec<FlowStep>,
    concurrency: Option<usize>,
    timeout_ms: Option<u64>,
    cleanup: Option<bool>,
    active: Option<bool>,
    browser_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBatchRunArgs {
    urls: Option<Vec<String>>,
    inputs: Option<Vec<BatchInput>>,
    concurrency: Option<usize>,
    timeout_ms: Option<u64>,
    cleanup: Option<bool>,
    active: Option<bool>,
    browser_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchInput {
    #[serde(default)]
    id: String,
    url: String,
}

#[derive(Debug, Clone)]
struct BatchOptions {
    timeout_ms: u64,
    cleanup: bool,
    active: bool,
    browser_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ExtractArgs {
    input: BatchInput,
    options: ExtractOptions,
}

impl ExtractArgs {
    fn parse(args: Map<String, Value>) -> Result<Self, FacadeError> {
        let raw = parse_args::<RawExtractArgs>(args)?;
        if raw.url.is_empty() {
            return Err(FacadeError::InvalidInput(
                "browser.extract requires a non-empty url".to_string(),
            ));
        }
        let options = raw.options();
        Ok(Self {
            input: BatchInput {
                id: raw.id.unwrap_or_else(|| "url-1".to_string()),
                url: raw.url,
            },
            options,
        })
    }
}

#[derive(Debug, Clone)]
struct CurrentExtractArgs {
    id: String,
    options: ExtractOptions,
}

impl CurrentExtractArgs {
    fn parse(args: Map<String, Value>) -> Result<Self, FacadeError> {
        let raw = parse_args::<RawCurrentExtractArgs>(args)?;
        let options = raw.options();
        Ok(Self {
            id: raw.id.unwrap_or_else(|| "current".to_string()),
            options,
        })
    }
}

#[derive(Debug, Clone)]
struct BatchExtractArgs {
    inputs: Vec<BatchInput>,
    concurrency: usize,
    options: ExtractOptions,
}

impl BatchExtractArgs {
    fn parse(args: Map<String, Value>) -> Result<Self, FacadeError> {
        let raw = parse_args::<RawBatchExtractArgs>(args)?;
        let options = raw.options();
        let inputs = parse_batch_inputs(raw.urls, raw.inputs, "browser.batch.extract")?;
        let concurrency = raw
            .concurrency
            .unwrap_or(DEFAULT_BATCH_CONCURRENCY)
            .clamp(1, MAX_BATCH_CONCURRENCY);

        Ok(Self {
            inputs,
            concurrency,
            options,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawExtractArgs {
    url: String,
    id: Option<String>,
    min_chars: Option<usize>,
    max_chars: Option<u64>,
    max_links: Option<u64>,
    include_a11y: Option<bool>,
    include_links: Option<bool>,
    cleanup: Option<bool>,
    active: Option<bool>,
    browser_id: Option<String>,
}

impl RawExtractArgs {
    fn options(&self) -> ExtractOptions {
        ExtractOptions {
            min_chars: clamp_min_chars(self.min_chars),
            max_chars: clamp_max_chars(self.max_chars),
            max_links: clamp_max_links(self.max_links),
            include_a11y: self.include_a11y.unwrap_or(false),
            include_links: self.include_links.unwrap_or(false),
            cleanup: self.cleanup.unwrap_or(true),
            active: self.active.unwrap_or(false),
            browser_id: self.browser_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCurrentExtractArgs {
    id: Option<String>,
    min_chars: Option<usize>,
    max_chars: Option<u64>,
    max_links: Option<u64>,
    include_a11y: Option<bool>,
    include_links: Option<bool>,
    browser_id: Option<String>,
}

impl RawCurrentExtractArgs {
    fn options(&self) -> ExtractOptions {
        ExtractOptions {
            min_chars: clamp_min_chars(self.min_chars),
            max_chars: clamp_max_chars(self.max_chars),
            max_links: clamp_max_links(self.max_links),
            include_a11y: self.include_a11y.unwrap_or(false),
            include_links: self.include_links.unwrap_or(false),
            cleanup: false,
            active: false,
            browser_id: self.browser_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBatchExtractArgs {
    urls: Option<Vec<String>>,
    inputs: Option<Vec<BatchInput>>,
    concurrency: Option<usize>,
    min_chars: Option<usize>,
    max_chars: Option<u64>,
    max_links: Option<u64>,
    include_a11y: Option<bool>,
    include_links: Option<bool>,
    cleanup: Option<bool>,
    active: Option<bool>,
    browser_id: Option<String>,
}

impl RawBatchExtractArgs {
    fn options(&self) -> ExtractOptions {
        ExtractOptions {
            min_chars: clamp_min_chars(self.min_chars),
            max_chars: clamp_max_chars(self.max_chars),
            max_links: clamp_max_links(self.max_links),
            include_a11y: self.include_a11y.unwrap_or(false),
            include_links: self.include_links.unwrap_or(false),
            cleanup: self.cleanup.unwrap_or(true),
            active: self.active.unwrap_or(false),
            browser_id: self.browser_id.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct ExtractOptions {
    min_chars: usize,
    max_chars: u64,
    max_links: u64,
    include_a11y: bool,
    include_links: bool,
    cleanup: bool,
    active: bool,
    browser_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum BatchStatus {
    Ok,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchItemResult {
    id: String,
    url: String,
    status: BatchStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl BatchItemResult {
    fn ok(
        input: BatchInput,
        tab_id: Option<i64>,
        title: Option<String>,
        text: Option<String>,
    ) -> Self {
        Self {
            id: input.id,
            url: input.url,
            status: BatchStatus::Ok,
            tab_id,
            title,
            text,
            error: None,
        }
    }

    fn failed(input: BatchInput, tab_id: Option<i64>, error: impl Into<String>) -> Self {
        Self {
            id: input.id,
            url: input.url,
            status: BatchStatus::Failed,
            tab_id,
            title: None,
            text: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchFlowItemResult {
    id: String,
    url: String,
    status: BatchStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    results: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stopped_at: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl BatchFlowItemResult {
    fn ok(input: BatchInput, tab_id: Option<i64>, title: Option<String>) -> Self {
        Self {
            id: input.id,
            url: input.url,
            status: BatchStatus::Ok,
            tab_id,
            title,
            results: Vec::new(),
            stopped_at: None,
            error: None,
        }
    }

    fn failed(input: BatchInput, tab_id: Option<i64>, error: impl Into<String>) -> Self {
        Self {
            id: input.id,
            url: input.url,
            status: BatchStatus::Failed,
            tab_id,
            title: None,
            results: Vec::new(),
            stopped_at: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum ExtractStatus {
    Ok,
    Partial,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractItemResult {
    id: String,
    url: String,
    status: ExtractStatus,
    tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    text: String,
    links: Vec<ExtractLink>,
    diagnostics: ExtractDiagnostics,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ExtractItemResult {
    fn ok(
        input: BatchInput,
        tab_id: Option<i64>,
        title: Option<String>,
        text: String,
        links: Vec<ExtractLink>,
        diagnostics: ExtractDiagnostics,
    ) -> Self {
        let status = if diagnostics.ready {
            ExtractStatus::Ok
        } else {
            ExtractStatus::Partial
        };
        Self {
            id: input.id,
            url: input.url,
            status,
            tab_id,
            title,
            text,
            links,
            diagnostics,
            error: None,
        }
    }

    fn failed(input: BatchInput, tab_id: Option<i64>, error: impl Into<String>) -> Self {
        Self {
            id: input.id,
            url: input.url,
            status: ExtractStatus::Failed,
            tab_id,
            title: None,
            text: String::new(),
            links: Vec::new(),
            diagnostics: ExtractDiagnostics::default(),
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExtractLink {
    text: String,
    url: String,
    source: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractDiagnostics {
    text_attempts: u32,
    elapsed_ms: u64,
    text_chars: usize,
    ready: bool,
    source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    extension_reason: String,
    #[serde(skip_serializing_if = "is_false")]
    a11y_attempted: bool,
    #[serde(skip_serializing_if = "is_zero_usize")]
    a11y_chars: usize,
    #[serde(skip_serializing_if = "is_false")]
    dom_attempted: bool,
    #[serde(skip_serializing_if = "is_zero_usize")]
    dom_chars: usize,
    #[serde(skip_serializing_if = "is_false")]
    text_truncated: bool,
    #[serde(skip_serializing_if = "is_false")]
    links_truncated: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<String>,
}

#[derive(Debug, Default)]
struct TextQuality {
    ready: bool,
    score: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DomSnapshot {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    tab_id: Option<i64>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    links: Vec<ExtractLink>,
    #[serde(default)]
    readiness: DomReadiness,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DomReadiness {
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Clone)]
struct OwnedTab {
    tab_id: i64,
    browser_id: Option<String>,
    cleanup: bool,
}

#[derive(Debug, Clone)]
struct FlowSession {
    session_id: String,
    tab_id: i64,
    browser_id: Option<String>,
    url: String,
    cleanup: bool,
}

impl FlowSession {
    fn to_value(&self) -> Value {
        Value::Object(self.to_value_object())
    }

    fn to_value_object(&self) -> Map<String, Value> {
        let mut value = Map::from_iter([
            ("sessionId".to_string(), json!(self.session_id)),
            ("tabId".to_string(), json!(self.tab_id)),
            ("url".to_string(), json!(self.url)),
            ("cleanup".to_string(), json!(self.cleanup)),
        ]);
        if let Some(browser_id) = &self.browser_id {
            value.insert("browserId".to_string(), json!(browser_id));
        }
        value
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsoleCaptureArgs {
    url: String,
    code: String,
    #[serde(default = "default_console_capture_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_console_capture_max_messages")]
    max_messages: u64,
    #[serde(default)]
    browser_id: Option<String>,
    #[serde(default)]
    active: bool,
    #[serde(default = "default_true")]
    cleanup: bool,
}

fn default_console_capture_timeout_ms() -> u64 {
    5_000
}

fn default_console_capture_max_messages() -> u64 {
    100
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkCaptureArgs {
    url: String,
    code: String,
    #[serde(default)]
    url_includes: Option<String>,
    #[serde(default = "default_network_capture_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_true")]
    include_response_bodies: bool,
    #[serde(default)]
    include_headers: bool,
    #[serde(default)]
    include_post_data: bool,
    #[serde(default = "default_network_capture_max_body_chars")]
    max_body_chars: u64,
    #[serde(default = "default_network_capture_max_requests")]
    max_requests: u64,
    #[serde(default)]
    browser_id: Option<String>,
    #[serde(default)]
    active: bool,
    #[serde(default = "default_true")]
    cleanup: bool,
}

fn new_flow_session_id() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("flow-{}", &id[..12])
}

fn default_network_capture_timeout_ms() -> u64 {
    10_000
}

fn default_network_capture_max_body_chars() -> u64 {
    20_000
}

fn default_network_capture_max_requests() -> u64 {
    20
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlowStartArgs {
    url: String,
    #[serde(default)]
    browser_id: Option<String>,
    #[serde(default)]
    active: bool,
    #[serde(default = "default_true")]
    cleanup: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlowObserveArgs {
    session_id: String,
    #[serde(default)]
    mode: ObserveMode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum ObserveMode {
    #[default]
    Text,
    A11y,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlowActArgs {
    session_id: String,
    steps: Vec<FlowStep>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum FlowStep {
    Goto {
        url: String,
    },
    Eval {
        code: String,
        #[serde(default, rename = "frameId")]
        frame_id: Option<String>,
    },
    Click {
        css: String,
        #[serde(default, rename = "frameId")]
        frame_id: Option<String>,
    },
    Fill {
        css: String,
        value: String,
        #[serde(default, rename = "frameId")]
        frame_id: Option<String>,
    },
    Select {
        css: String,
        value: String,
        #[serde(default, rename = "frameId")]
        frame_id: Option<String>,
    },
    Wait {
        ms: u64,
    },
    ReadText {
        #[serde(default, rename = "frameId")]
        frame_id: Option<String>,
    },
}

impl FlowStep {
    fn kind(&self) -> &'static str {
        match self {
            Self::Goto { .. } => "goto",
            Self::Eval { .. } => "eval",
            Self::Click { .. } => "click",
            Self::Fill { .. } => "fill",
            Self::Select { .. } => "select",
            Self::Wait { .. } => "wait",
            Self::ReadText { .. } => "read_text",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlowFinishArgs {
    session_id: String,
    cleanup: Option<bool>,
}

fn parse_args<T>(args: Map<String, Value>) -> Result<T, FacadeError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(Value::Object(args))
        .map_err(|error| FacadeError::InvalidInput(error.to_string()))
}

fn parse_batch_inputs(
    urls: Option<Vec<String>>,
    inputs: Option<Vec<BatchInput>>,
    tool_name: &str,
) -> Result<Vec<BatchInput>, FacadeError> {
    let inputs = match (urls, inputs) {
        (Some(urls), None) => urls
            .into_iter()
            .enumerate()
            .map(|(index, url)| BatchInput {
                id: format!("url-{}", index + 1),
                url,
            })
            .collect::<Vec<_>>(),
        (None, Some(inputs)) => inputs
            .into_iter()
            .enumerate()
            .map(|(index, mut input)| {
                if input.id.is_empty() {
                    input.id = format!("input-{}", index + 1);
                }
                input
            })
            .collect(),
        (Some(_), Some(_)) => {
            return Err(FacadeError::InvalidInput(
                "provide either urls or inputs, not both".to_string(),
            ));
        }
        (None, None) => {
            return Err(FacadeError::InvalidInput(format!(
                "{tool_name} requires urls or inputs"
            )));
        }
    };

    if inputs.is_empty() {
        return Err(FacadeError::InvalidInput(format!(
            "{tool_name} requires at least one URL"
        )));
    }
    if let Some(input) = inputs.iter().find(|input| input.url.is_empty()) {
        return Err(FacadeError::InvalidInput(format!(
            "input {} has an empty url",
            input.id
        )));
    }
    Ok(inputs)
}

fn default_true() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn clamp_min_chars(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_TEXT_READY_MIN_CHARS)
        .clamp(1, MAX_TEXT_READY_MIN_CHARS)
}

fn clamp_max_chars(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_EXTRACT_MAX_CHARS)
        .clamp(1, MAX_EXTRACT_MAX_CHARS)
}

fn clamp_max_links(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_EXTRACT_MAX_LINKS)
        .min(MAX_EXTRACT_MAX_LINKS)
}

fn fail_if_tool_error(tool: &'static str, result: &BridgeToolResult) -> Result<(), FacadeError> {
    if let Some(message) = tool_error_message(result) {
        Err(FacadeError::ToolFailed { tool, message })
    } else {
        Ok(())
    }
}

fn tool_error_message(result: &BridgeToolResult) -> Option<String> {
    result.is_error.then(|| {
        find_string_key(&result.result, "message")
            .or_else(|| extract_text(&result.result))
            .unwrap_or_else(|| "browser tool returned an error".to_string())
    })
}

fn parse_capture_json(
    tool: &'static str,
    result: &Value,
    tab_id: i64,
    url: &str,
    browser_id: Option<&str>,
) -> Result<Value, FacadeError> {
    let text = extract_text(result).ok_or_else(|| FacadeError::ToolFailed {
        tool,
        message: "response did not contain JSON text".to_string(),
    })?;
    let mut value =
        serde_json::from_str::<Value>(&text).map_err(|error| FacadeError::ToolFailed {
            tool,
            message: format!("response was not valid JSON: {error}"),
        })?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| FacadeError::ToolFailed {
            tool,
            message: "response JSON was not an object".to_string(),
        })?;
    object.insert("tabId".to_string(), json!(tab_id));
    object.insert("url".to_string(), json!(url));
    if let Some(browser_id) = browser_id {
        object.insert("browserId".to_string(), json!(browser_id));
    }
    Ok(value)
}

fn finish_capture(
    tool: &'static str,
    outcome: Result<Value, FacadeError>,
    cleanup_error: Option<FacadeError>,
) -> Result<Value, FacadeError> {
    match (outcome, cleanup_error) {
        (Ok(value), None) => Ok(value),
        (Ok(_value), Some(error)) => Err(error),
        (Err(error), None) => Err(error),
        (Err(error), Some(cleanup)) => Err(FacadeError::ToolFailed {
            tool,
            message: format!("{error}; cleanup failed: {cleanup}"),
        }),
    }
}

fn single_result(result: Value) -> Map<String, Value> {
    Map::from_iter([("result".to_string(), result)])
}

fn javascript_tool_args(code: String, await_promise: bool, frame_id: Option<String>) -> Value {
    let mut args = Map::from_iter([
        ("code".to_string(), json!(code)),
        ("awaitPromise".to_string(), json!(await_promise)),
    ]);
    if let Some(frame_id) = frame_id {
        args.insert("frameId".to_string(), json!(frame_id));
    }
    Value::Object(args)
}

fn javascript_string_result(result: &Value) -> Result<String, FacadeError> {
    let text = extract_text(result).ok_or_else(|| FacadeError::ToolFailed {
        tool: "javascript_tool",
        message: "frame read returned no text".to_string(),
    })?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::String(value)) => Ok(value),
        Ok(value) => Ok(value.to_string()),
        Err(_error) => Ok(text),
    }
}

fn click_script(css: &str) -> Result<String, FacadeError> {
    let selector = serde_json::to_string(css)?;
    Ok(format!(
        r#"(() => {{
const selector = {selector};
const element = document.querySelector(selector);
if (!element) throw new Error(`No element matches selector: ${{selector}}`);
element.click();
return true;
}})()"#
    ))
}

fn fill_script(css: &str, value: &str) -> Result<String, FacadeError> {
    let selector = serde_json::to_string(css)?;
    let value = serde_json::to_string(value)?;
    Ok(format!(
        r#"(() => {{
const selector = {selector};
const value = {value};
const element = document.querySelector(selector);
if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {{
  throw new Error(`No text input matches selector: ${{selector}}`);
}}
const prototype = element instanceof HTMLInputElement
  ? HTMLInputElement.prototype
  : HTMLTextAreaElement.prototype;
const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
element.focus();
if (setter) setter.call(element, value);
else element.value = value;
element.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: value }}));
element.dispatchEvent(new Event("change", {{ bubbles: true }}));
return true;
}})()"#
    ))
}

fn select_script(css: &str, value: &str) -> Result<String, FacadeError> {
    let selector = serde_json::to_string(css)?;
    let value = serde_json::to_string(value)?;
    Ok(format!(
        r#"(() => {{
const selector = {selector};
const value = {value};
const element = document.querySelector(selector);
if (!(element instanceof HTMLSelectElement)) {{
  throw new Error(`No select element matches selector: ${{selector}}`);
}}
if (!Array.from(element.options).some((option) => option.value === value)) {{
  throw new Error(`Select option value not found: ${{value}}`);
}}
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
if (setter) setter.call(element, value);
else element.value = value;
element.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertReplacementText", data: value }}));
element.dispatchEvent(new Event("change", {{ bubbles: true }}));
return true;
}})()"#
    ))
}

fn extract_tab_id(value: &Value) -> Option<i64> {
    find_i64_key(value, "tabId")
        .or_else(|| find_i64_key(value, "id"))
        .or_else(|| extract_created_tab_id_from_text(value))
}

fn extract_title(value: &Value) -> Option<String> {
    find_string_key(value, "title")
}

fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(object) => {
            if let Some(Value::String(text)) = object.get("text") {
                return Some(text.clone());
            }
            if let Some(Value::Array(content)) = object.get("content") {
                let parts = content
                    .iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .map(ToString::to_string)
                    .collect::<Vec<_>>();
                if !parts.is_empty() {
                    return Some(parts.join("\n"));
                }
            }
            object.values().find_map(extract_text)
        }
        Value::Array(items) => items.iter().find_map(extract_text),
        Value::Null | Value::Bool(_) | Value::Number(_) => None,
    }
}

fn has_page_text(text: &str) -> bool {
    text_quality(text, DEFAULT_TEXT_READY_MIN_CHARS).ready
}

fn text_quality(text: &str, min_chars: usize) -> TextQuality {
    let text = text.trim();
    if text.is_empty() || text == "(no text content found)" || text == "Skip to main content" {
        return TextQuality::default();
    }

    let chars = text.chars().count();
    let line_count = text.lines().filter(|line| !line.trim().is_empty()).count();
    let token_count = text
        .split_whitespace()
        .filter(|token| token.chars().any(|ch| ch.is_alphanumeric()))
        .count();
    let nav_shell_penalty = usize::from(is_probable_nav_shell(text)) * 200;
    let score = chars
        .saturating_add(line_count.saturating_mul(12))
        .saturating_add(token_count.saturating_mul(4))
        .saturating_sub(nav_shell_penalty);
    let ready = chars >= min_chars && token_count >= 12 && !is_probable_nav_shell(text);

    TextQuality { ready, score }
}

fn is_probable_nav_shell(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let shell_markers = [
        "skip to main content",
        "skip to navigation",
        "collapse navigation",
    ];
    let has_shell_marker = shell_markers.iter().any(|marker| lower.contains(marker));
    let app_nav_markers = [
        "home",
        "notifications",
        "messaging",
        "my network",
        "for business",
        "primary content",
    ];
    let app_nav_hits = app_nav_markers
        .iter()
        .filter(|marker| lower.contains(**marker))
        .count();
    let has_content_marker = [
        "feed post",
        "reaction button",
        "comment",
        "repost",
        "followers",
    ]
    .iter()
    .any(|marker| lower.contains(*marker));

    (has_shell_marker && text.chars().count() < DEFAULT_TEXT_READY_MIN_CHARS)
        || (app_nav_hits >= 4 && !has_content_marker)
}

fn parse_a11y_links(text: &str) -> Vec<ExtractLink> {
    text.lines()
        .filter_map(|line| {
            let (_, rest) = line.split_once("link \"")?;
            let (label, rest) = rest.split_once("\" href=\"")?;
            let (url, _) = rest.split_once('"')?;
            Some(ExtractLink {
                text: label.trim().to_string(),
                url: url.trim().to_string(),
                source: "a11y".to_string(),
            })
        })
        .filter(|link| !link.url.is_empty())
        .collect()
}

fn dedupe_links(links: &mut Vec<ExtractLink>) {
    let mut seen = std::collections::HashSet::new();
    links.retain(|link| seen.insert((link.url.clone(), link.text.clone())));
}

fn enforce_extract_limits(
    text: &mut String,
    links: &mut Vec<ExtractLink>,
    options: &ExtractOptions,
) {
    *text = truncate_chars(text, options.max_chars as usize);

    if !options.include_links {
        links.clear();
        return;
    }
    links.truncate(options.max_links as usize);
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

fn parse_dom_snapshot(value: &Value) -> Result<DomSnapshot, FacadeError> {
    if let Ok(snapshot) = serde_json::from_value::<DomSnapshot>(value.clone()) {
        if !snapshot.text.is_empty()
            || !snapshot.links.is_empty()
            || !snapshot.readiness.reason.is_empty()
        {
            return Ok(snapshot);
        }
    }

    let text = extract_text(value).ok_or_else(|| FacadeError::ToolFailed {
        tool: "javascript_tool",
        message: "DOM snapshot returned no text".to_string(),
    })?;
    let decoded = match serde_json::from_str::<Value>(&text) {
        Ok(Value::String(inner)) => inner,
        Ok(value) => return Ok(serde_json::from_value(value)?),
        Err(error) => {
            return Err(FacadeError::ToolFailed {
                tool: "javascript_tool",
                message: format!("failed to parse DOM snapshot wrapper: {error}"),
            });
        }
    };
    Ok(serde_json::from_str(&decoded)?)
}

fn dom_extract_script() -> &'static str {
    r#"(() => {
const textParts = [];
const links = [];
const seenNodes = new Set();
const seenLinks = new Set();

function addText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text) textParts.push(text);
}

function addLink(element) {
  const href = element.href || element.getAttribute("href");
  if (!href || seenLinks.has(href)) return;
  seenLinks.add(href);
  const text = (element.innerText || element.getAttribute("aria-label") || element.textContent || href)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  links.push({ text, url: href, source: "dom" });
}

function isHidden(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
}

function walk(node, depth = 0) {
  if (!node || seenNodes.has(node) || depth > 80) return;
  seenNodes.add(node);

  if (node.nodeType === Node.TEXT_NODE) {
    addText(node.textContent);
    return;
  }

  if (
    node.nodeType !== Node.ELEMENT_NODE &&
    node.nodeType !== Node.DOCUMENT_NODE &&
    node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
  ) {
    return;
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
  if (element) {
    if (isHidden(element)) return;
    addText(element.getAttribute("aria-label"));
    if (element.matches("a[href]")) addLink(element);
  }

  for (const child of node.childNodes || []) walk(child, depth + 1);
  if (element && element.shadowRoot) walk(element.shadowRoot, depth + 1);
}

walk(document.body || document.documentElement);

const text = Array.from(new Set(textParts)).join("\n").slice(0, 60000);
return JSON.stringify({
  title: document.title || "",
  url: location.href,
  text,
  links: links.slice(0, 200)
});
})()"#
}

fn find_i64_key(value: &Value, key: &str) -> Option<i64> {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(Value::as_i64) {
                return Some(found);
            }
            object.values().find_map(|value| find_i64_key(value, key))
        }
        Value::Array(items) => items.iter().find_map(|value| find_i64_key(value, key)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => None,
    }
}

fn find_string_key(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(Value::as_str) {
                return Some(found.to_string());
            }
            object
                .values()
                .find_map(|value| find_string_key(value, key))
        }
        Value::Array(items) => items.iter().find_map(|value| find_string_key(value, key)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => None,
    }
}

fn extract_created_tab_id_from_text(value: &Value) -> Option<i64> {
    let text = extract_text(value)?;
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("Created tab:") else {
            continue;
        };
        let digits = rest
            .trim_start()
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect::<String>();
        if let Ok(tab_id) = digits.parse() {
            return Some(tab_id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        click_script, enforce_extract_limits, extract_tab_id, fill_script, has_page_text,
        new_flow_session_id, parse_dom_snapshot, select_script, BatchFlowArgs, BatchRunArgs,
        CurrentExtractArgs, ExtractArgs, ExtractLink, ExtractOptions, FlowActArgs, FlowStep,
        NetworkCaptureArgs,
    };

    #[test]
    fn batch_args_accept_urls_and_clamp_concurrency() {
        let args = BatchRunArgs::parse(
            json!({
                "urls": ["https://example.test"],
                "concurrency": 99,
                "timeoutMs": 0
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();

        assert_eq!(args.inputs.len(), 1);
        assert_eq!(args.inputs[0].id, "url-1");
        assert_eq!(args.concurrency, 16);
        assert_eq!(args.options.timeout_ms, 1);
        assert!(args.options.cleanup);
        assert!(!args.options.active);
    }

    #[test]
    fn batch_args_reject_ambiguous_input_sources() {
        let error = BatchRunArgs::parse(
            json!({
                "urls": ["https://example.test"],
                "inputs": [{"id": "a", "url": "https://example.test"}]
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("either urls or inputs"));
    }

    #[test]
    fn batch_inputs_default_missing_ids() {
        let args = BatchRunArgs::parse(
            json!({
                "inputs": [{"url": "https://example.test"}]
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();

        assert_eq!(args.inputs[0].id, "input-1");
    }

    #[test]
    fn batch_flow_args_require_steps_and_clamp_limits() {
        let args = BatchFlowArgs::parse(
            json!({
                "urls": ["https://example.test/a", "https://example.test/b"],
                "steps": [
                    {"type": "wait", "ms": 10},
                    {"type": "eval", "code": "document.title"}
                ],
                "concurrency": 99,
                "timeoutMs": 0
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();

        assert_eq!(args.inputs.len(), 2);
        assert_eq!(args.steps.len(), 2);
        assert_eq!(args.concurrency, 16);
        assert_eq!(args.options.timeout_ms, 1);
        assert!(args.options.cleanup);
        assert!(!args.options.active);
    }

    #[test]
    fn batch_flow_args_reject_empty_steps() {
        let error = BatchFlowArgs::parse(
            json!({
                "urls": ["https://example.test"],
                "steps": []
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("at least one step"));
    }

    #[test]
    fn flow_session_ids_are_short_and_opaque() {
        let id = new_flow_session_id();

        assert!(id.starts_with("flow-"));
        assert_eq!(id.len(), 17);
        assert!(id[5..]
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn network_capture_args_use_bounded_defaults() {
        let args: NetworkCaptureArgs = serde_json::from_value(json!({
            "url": "https://example.test",
            "code": "fetch('/api')"
        }))
        .unwrap();

        assert_eq!(args.timeout_ms, 10_000);
        assert_eq!(args.max_body_chars, 20_000);
        assert_eq!(args.max_requests, 20);
        assert!(args.include_response_bodies);
        assert!(args.cleanup);
        assert!(!args.active);
    }

    #[test]
    fn flow_steps_parse_explicit_step_types() {
        let args: FlowActArgs = serde_json::from_value(json!({
            "sessionId": "session",
            "steps": [
                {"type": "goto", "url": "https://example.test"},
                {"type": "select", "css": "#sort", "value": "lohi", "frameId": "child-1"},
                {"type": "read_text", "frameId": "child-1"}
            ]
        }))
        .unwrap();

        assert_eq!(args.steps.len(), 3);
        assert!(matches!(args.steps[0], FlowStep::Goto { .. }));
        assert!(matches!(
            &args.steps[1],
            FlowStep::Select {
                frame_id: Some(frame_id),
                ..
            } if frame_id == "child-1"
        ));
        assert!(matches!(
            &args.steps[2],
            FlowStep::ReadText {
                frame_id: Some(frame_id)
            } if frame_id == "child-1"
        ));
    }

    #[test]
    fn css_scripts_json_escape_inputs() {
        let click = click_script(r#"button[data-label="Save"]"#).unwrap();
        assert!(click.contains(r#"button[data-label=\"Save\"]"#));

        let fill = fill_script("#name", "Alice\nBob").unwrap();
        assert!(fill.contains(r#""Alice\nBob""#));
        assert!(fill.contains("HTMLInputElement.prototype"));

        let select = select_script("#sort", "lohi").unwrap();
        assert!(select.contains(r#""lohi""#));
        assert!(select.contains("HTMLSelectElement.prototype"));
    }

    #[test]
    fn extracts_tab_id_from_text_only_create_result() {
        let value = json!({
            "content": [{"type": "text", "text": "Created tab: 123"}]
        });

        assert_eq!(extract_tab_id(&value), Some(123));
    }

    #[test]
    fn recognizes_placeholder_page_text_as_not_ready() {
        assert!(!has_page_text(""));
        assert!(!has_page_text("  (no text content found)  "));
        assert!(has_page_text(
            "Example Domain\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.\nLearn more"
        ));
    }

    #[test]
    fn extract_args_default_to_short_dom_path() {
        let args = ExtractArgs::parse(
            json!({
                "url": "https://example.test"
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();

        assert!(!args.options.include_a11y);
        assert!(!args.options.include_links);
        assert_eq!(args.options.max_chars, 8_000);
        assert_eq!(args.options.max_links, 20);
    }

    #[test]
    fn current_extract_defaults_to_compact_current_page() {
        let args = CurrentExtractArgs::parse(json!({}).as_object().unwrap().clone()).unwrap();

        assert_eq!(args.id, "current");
        assert!(!args.options.include_a11y);
        assert!(!args.options.include_links);
        assert_eq!(args.options.max_chars, 8_000);
        assert_eq!(args.options.max_links, 20);
        assert!(!args.options.cleanup);
        assert!(!args.options.active);
    }

    #[test]
    fn extract_args_clamp_public_limits() {
        let args = ExtractArgs::parse(
            json!({
                "url": "https://example.test",
                "minChars": 999999,
                "maxChars": 999999,
                "maxLinks": 999999
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();

        assert_eq!(args.options.min_chars, 10_000);
        assert_eq!(args.options.max_chars, 60_000);
        assert_eq!(args.options.max_links, 200);
    }

    #[test]
    fn extract_limits_apply_after_fallbacks() {
        let mut text = "abcdef".to_string();
        let mut links = vec![
            ExtractLink {
                text: "a".to_string(),
                url: "https://example.test/a".to_string(),
                source: "dom".to_string(),
            },
            ExtractLink {
                text: "b".to_string(),
                url: "https://example.test/b".to_string(),
                source: "dom".to_string(),
            },
        ];
        let options = ExtractOptions {
            min_chars: 1,
            max_chars: 3,
            max_links: 1,
            include_a11y: false,
            include_links: true,
            cleanup: true,
            active: false,
            browser_id: None,
        };

        enforce_extract_limits(&mut text, &mut links, &options);

        assert_eq!(text, "abc");
        assert_eq!(links.len(), 1);
    }

    #[test]
    fn parse_dom_snapshot_accepts_structured_result() {
        let snapshot = parse_dom_snapshot(&json!({
            "text": "hello",
            "links": [{"text": "Example", "url": "https://example.test", "source": "dom"}],
            "readiness": {"reason": "dom_quiet"}
        }))
        .unwrap();

        assert_eq!(snapshot.text, "hello");
        assert_eq!(snapshot.links.len(), 1);
        assert_eq!(snapshot.readiness.reason, "dom_quiet");
    }
}
