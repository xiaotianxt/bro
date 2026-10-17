//! Scoped 1Password reads and private browser fill. Provider output and secret
//! values never enter public tool arguments/results, Debug output, or errors.
use std::{
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::{io::AsyncReadExt, process::Command};
use url::Url;

use crate::bridge::BrowserBridge;

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FindArgs {
    url: String,
    #[serde(default)]
    vault: Option<String>,
    #[serde(default)]
    account: Option<String>,
    confirm_metadata_search: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectArgs {
    browser_id: String,
    tab_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FillArgs {
    browser_id: String,
    tab_id: i64,
    document_id: String,
    form_token: String,
    expected_origin: String,
    item_id: String,
    vault_id: String,
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    username_index: Option<usize>,
    #[serde(default)]
    password_index: Option<usize>,
    confirm_fill: bool,
}

// These provider-owned strings intentionally do not implement Debug/Serialize.
#[derive(Deserialize)]
struct Item {
    id: String,
    #[serde(default)]
    title: String,
    vault: Vault,
    #[serde(default)]
    urls: Vec<Website>,
    #[serde(default)]
    fields: Vec<Field>,
    #[serde(default)]
    category: String,
}
#[derive(Deserialize)]
struct Vault {
    id: String,
}
#[derive(Deserialize)]
struct Website {
    href: String,
}
#[derive(Deserialize)]
struct Field {
    id: String,
    #[serde(default)]
    value: String,
}

fn parse<T: serde::de::DeserializeOwned>(args: Map<String, Value>) -> Result<T> {
    serde_json::from_value(Value::Object(args)).map_err(|_| "Invalid login tool arguments")
}

fn origin(input: &str) -> Result<String> {
    let url = Url::parse(input).map_err(|_| "Expected an absolute HTTPS URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL must not contain credentials");
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("HTTPS is required except on literal loopback hosts");
    }
    if url.host_str().is_none() {
        return Err("URL has no hostname");
    }
    Ok(url.origin().ascii_serialization())
}

fn matches_origin(item: &Item, expected: &str) -> bool {
    item.urls
        .iter()
        .any(|website| origin(&website.href).is_ok_and(|value| value == expected))
}

fn identifier(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn scope(value: &Option<String>) -> Result<()> {
    if value.as_ref().is_some_and(|v| {
        v.is_empty() || v.starts_with('-') || v.len() > 256 || v.chars().any(char::is_control)
    }) {
        return Err("Invalid account or vault scope");
    }
    Ok(())
}

#[cfg(not(feature = "credential-test-provider"))]
fn op_path() -> &'static str {
    // launchd's PATH need not contain Homebrew. Never accept an executable path
    // from a model-facing request or invoke a shell with provider arguments.
    if cfg!(target_os = "macos") {
        for path in ["/opt/homebrew/bin/op", "/usr/local/bin/op"] {
            if std::path::Path::new(path).is_file() {
                return path;
            }
        }
    }
    "op"
}

async fn provider(arguments: &[&str], account: &Option<String>, limit: u64) -> Result<Vec<u8>> {
    scope(account)?;
    let operation = async {
        #[cfg(feature = "credential-test-provider")]
        let executable = std::env::var_os("BRO_TEST_OP").ok_or(
            "Test build requires an explicit disposable provider; real vault access disabled",
        )?;
        #[cfg(not(feature = "credential-test-provider"))]
        let executable = op_path();
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .args(["--format", "json"])
            .env_remove("OP_INCLUDE_ARCHIVE")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(account) = account {
            command.args(["--account", account]);
        }
        let mut child = command.spawn().map_err(|_| {
            "1Password CLI unavailable to bro; install op or check its executable permissions"
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or("1Password CLI output unavailable")?;
        let mut output = Vec::new();
        stdout
            .take(limit + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| "1Password CLI read failed")?;
        if output.len() as u64 > limit {
            let _ = child.kill().await;
            return Err("1Password output too large; narrow the vault scope");
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "1Password CLI exited unexpectedly")?;
        if !status.success() {
            return Err("1Password CLI refused the request. Unlock/approve CLI access in 1Password and verify the account, vault and item selection. Raw provider output was withheld.");
        }
        Ok(output)
    };
    tokio::time::timeout(Duration::from_secs(45), operation)
        .await
        .map_err(|_| "1Password CLI authorization/read timed out; no automatic retry")?
}

pub async fn find(args: Map<String, Value>) -> Result<Value> {
    let args: FindArgs = parse(args)?;
    if !args.confirm_metadata_search {
        return Err("Explicit confirmMetadataSearch is required to search login metadata locally");
    }
    let expected = origin(&args.url)?;
    scope(&args.vault)?;
    let mut command = vec!["item", "list", "--categories", "Login"];
    if let Some(vault) = &args.vault {
        command.extend(["--vault", vault]);
    }
    let output = provider(&command, &args.account, 4 * 1024 * 1024).await?;
    let items: Vec<Item> =
        serde_json::from_slice(&output).map_err(|_| "Invalid 1Password metadata response")?;
    let candidates: Vec<_> = items.iter().filter(|item| matches_origin(item, &expected))
        .map(|item| json!({"itemId": item.id, "vaultId": item.vault.id, "title": item.title.chars().take(120).collect::<String>()}))
        .collect();
    Ok(
        json!({"origin": expected, "candidates": candidates, "matching": "exact-origin", "credentialsRead": false}),
    )
}

fn connection(bridge: &BrowserBridge, browser_id: &str, tab_id: i64) -> Result<String> {
    if tab_id <= 0 {
        return Err("Explicit positive tabId is required");
    }
    bridge
        .status()
        .extensions
        .into_iter()
        .find(|extension| extension.browser_id == browser_id)
        .map(|extension| extension.session_id)
        .ok_or("Pinned browser is not connected")
}

async fn private_call(
    bridge: &BrowserBridge,
    tool: &str,
    args: Value,
    browser: &str,
    session: &str,
    tab: i64,
) -> Result<Value> {
    let reply = bridge
        .dispatch_bound(
            tool,
            args,
            Some(tab),
            Some(browser.to_owned()),
            Some(session),
        )
        .await
        .map_err(|_| "Login browser operation failed; inspect state before any retry")?;
    if reply.is_error {
        return Err("Login browser operation failed; no credentials or raw error returned");
    }
    let text = reply
        .result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .ok_or("Invalid private login response")?;
    serde_json::from_str(text).map_err(|_| "Invalid private login response")
}

fn safe_status(value: &Value) -> Result<&'static str> {
    match value.get("status").and_then(Value::as_str) {
        Some("ready") => Ok("ready"),
        Some("filled") => Ok("filled"),
        Some("cancelled") => Err("Login authorization was cancelled or consumed; no automatic retry"),
        Some("origin_changed") => Err("Login origin changed; no fill authorized"),
        Some("stale_form") => Err("Login form changed; inspect a fresh form before choosing targets"),
        Some("expired") => Err("Login form expired; inspect again, do not replay automatically"),
        Some("field_not_empty") => Err("Target field is nonempty; refusing to overwrite user input"),
        Some("invalid_field") => Err("Invalid login field selection; use visible username/password fields, not new-password or OTP fields"),
        Some("fill_unverified") => Err("Fill dispatched but not verified; inspect outcome without reading field values, do not replay"),
        _ => Err("Login operation unavailable or failed; no automatic fallback or retry"),
    }
}

pub async fn inspect(bridge: &BrowserBridge, args: Map<String, Value>) -> Result<Value> {
    let args: InspectArgs = parse(args)?;
    let session = connection(bridge, &args.browser_id, args.tab_id)?;
    let value = private_call(
        bridge,
        "__bro_login_inspect",
        json!({}),
        &args.browser_id,
        &session,
        args.tab_id,
    )
    .await?;
    safe_status(&value)?;
    let expected = origin(
        value
            .get("origin")
            .and_then(Value::as_str)
            .ok_or("Missing login origin")?,
    )?;
    let document = value
        .get("documentId")
        .and_then(Value::as_str)
        .ok_or("Missing login document")?;
    let token = value
        .get("formToken")
        .and_then(Value::as_str)
        .ok_or("Missing form token")?;
    let fields: Vec<_> = value
        .get("fields")
        .and_then(Value::as_array)
        .ok_or("Missing login controls")?
        .iter()
        .filter_map(|field| {
            let index = field.get("index")?.as_u64()?;
            let kind = field.get("type")?.as_str()?;
            if !["text", "email", "tel", "password"].contains(&kind) {
                return None;
            }
            // Do not expose arbitrary labels, names, values or autocomplete text.
            Some(json!({"index": index, "type": kind}))
        })
        .collect();
    Ok(
        json!({"origin": expected, "documentId": document, "formToken": token, "fields": fields,
        "expiresInSeconds": 120, "scope": "main-frame", "valuesRead": false}),
    )
}

fn expiry() -> Result<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock unavailable")?;
    Ok(now.as_millis() as u64 + 10_000)
}

pub async fn fill(bridge: &BrowserBridge, args: Map<String, Value>) -> Result<Value> {
    let args: FillArgs = parse(args)?;
    if !args.confirm_fill {
        return Err("Explicit confirmFill required for the selected login and origin");
    }
    if !identifier(&args.item_id) || !identifier(&args.vault_id) {
        return Err("Select exact itemId and vaultId returned by onepassword_find_logins");
    }
    if args.username_index.is_none() && args.password_index.is_none() {
        return Err("Select at least one input index from login_form_inspect");
    }
    let expected = origin(&args.expected_origin)?;
    if expected != args.expected_origin {
        return Err("expectedOrigin must be a canonical origin without a path or query");
    }
    let session = connection(bridge, &args.browser_id, args.tab_id)?;
    let mut request = json!({"expectedOrigin": expected, "documentId": args.document_id,
        "formToken": args.form_token, "checkOnly": true, "expiresAt": expiry()?});
    if let Some(index) = args.username_index {
        request["usernameIndex"] = json!(index);
    }
    if let Some(index) = args.password_index {
        request["passwordIndex"] = json!(index);
    }
    let checked = private_call(
        bridge,
        "__bro_login_fill",
        request.clone(),
        &args.browser_id,
        &session,
        args.tab_id,
    )
    .await?;
    if safe_status(&checked)? != "ready" {
        return Err("Invalid login preflight response");
    }
    let output = provider(
        &[
            "item",
            "get",
            &args.item_id,
            "--vault",
            &args.vault_id,
            "--reveal",
        ],
        &args.account,
        256 * 1024,
    )
    .await?;
    let item: Item =
        serde_json::from_slice(&output).map_err(|_| "Invalid 1Password item response")?;
    if item.id != args.item_id
        || item.vault.id != args.vault_id
        || item.category != "LOGIN"
        || !matches_origin(&item, &expected)
    {
        return Err(
            "Selected login does not match the exact HTTPS origin, item or vault; refusing to fill",
        );
    }
    for (index, id) in [
        (args.username_index, "username"),
        (args.password_index, "password"),
    ] {
        if index.is_none() {
            continue;
        }
        let fields: Vec<_> = item
            .fields
            .iter()
            .filter(|field| field.id == id && !field.value.is_empty())
            .collect();
        if fields.len() != 1 {
            return Err("Selected login lacks a unique requested credential field. Passkeys are not supported by this password-fill path.");
        }
        request[id] = json!(fields[0].value);
    }
    request["checkOnly"] = json!(false);
    request["expiresAt"] = json!(expiry()?);
    let result = private_call(
        bridge,
        "__bro_login_fill",
        request,
        &args.browser_id,
        &session,
        args.tab_id,
    )
    .await?;
    if safe_status(&result)? != "filled" {
        return Err("Unexpected fill result; inspect state before any retry");
    }
    Ok(json!({"filled": true, "submitDispatched": false,
        "note": "No submit was dispatched by bro. The destination site can read and react to filled values. Do not inspect values or capture secret-bearing logs/screenshots; verify navigation before submitting separately."}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_matching_is_exact_not_substring_or_registrable_domain() {
        assert_eq!(
            origin("https://EXAMPLE.com/a?q=1"),
            Ok("https://example.com".into())
        );
        assert_ne!(
            origin("https://example.com.evil.test/"),
            origin("https://example.com/")
        );
        assert_ne!(
            origin("https://login.example.com/"),
            origin("https://example.com/")
        );
        assert_ne!(
            origin("https://example.com:444/"),
            origin("https://example.com/")
        );
        assert!(origin("https://user:password@example.com/").is_err());
        assert!(origin("http://example.com/").is_err());
        assert!(origin("http://localhost:1234/").is_ok());
    }

    #[test]
    fn untrusted_errors_never_echo_provider_or_page_values() {
        let value = json!({"status": "secret-canary", "error": "secret-canary"});
        assert!(!safe_status(&value).unwrap_err().contains("secret-canary"));
        assert!(scope(&Some("--reveal".into())).is_err());
    }
}
