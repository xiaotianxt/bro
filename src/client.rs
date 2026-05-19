use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

#[cfg(test)]
use anyhow::anyhow;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

const READ_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

pub fn call_tool(bind: SocketAddr, token: &str, tool: &str, arguments: Value) -> Result<Value> {
    let initialize = post_json(
        bind,
        token,
        None,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "bro-cli",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )
    .context("failed to initialize MCP session")?;

    let session_id = initialize
        .headers
        .get("mcp-session-id")
        .cloned()
        .context("MCP initialize response did not include mcp-session-id")?;
    let initialize_body = parse_sse_or_json(&initialize.body)?;
    ensure_jsonrpc_ok(&initialize_body)?;

    let call = post_json(
        bind,
        token,
        Some(&session_id),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": tool,
                "arguments": arguments
            }
        }),
    )
    .with_context(|| format!("failed to call MCP tool {tool}"))?;

    let call_body = parse_sse_or_json(&call.body)?;
    ensure_jsonrpc_ok(&call_body)?;
    Ok(call_body)
}

#[derive(Debug)]
struct HttpResponse {
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn post_json(
    bind: SocketAddr,
    token: &str,
    session_id: Option<&str>,
    body: Value,
) -> Result<HttpResponse> {
    let body = serde_json::to_vec(&body)?;
    let mut request = Vec::new();
    write!(
        request,
        "POST /mcp HTTP/1.1\r\n\
         Host: {bind}\r\n\
         Content-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n",
        body.len()
    )?;
    if let Some(session_id) = session_id {
        write!(request, "Mcp-Session-Id: {session_id}\r\n")?;
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(&body);

    let mut stream =
        TcpStream::connect(bind).with_context(|| format!("failed to connect {bind}"))?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    stream.write_all(&request)?;

    read_http_response(&mut stream)
}

#[cfg(test)]
fn parse_http_response(response: &[u8]) -> Result<HttpResponse> {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        bail!("HTTP response did not include a header terminator");
    };
    let (raw_headers, raw_body) = response.split_at(header_end);
    let raw_body = &raw_body[4..];
    let headers_text = std::str::from_utf8(raw_headers).context("HTTP headers were not UTF-8")?;
    let mut lines = headers_text.lines();
    let status_line = lines.next().context("HTTP response missing status line")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .context("HTTP status line missing status code")?
        .parse::<u16>()
        .context("HTTP status code was not numeric")?;

    let headers = parse_headers(lines);

    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked(raw_body)?
    } else {
        raw_body.to_vec()
    };

    if !(200..300).contains(&status) {
        let text = String::from_utf8_lossy(&body);
        bail!("HTTP {status}: {text}");
    }

    Ok(HttpResponse { headers, body })
}

fn read_http_response(stream: &mut TcpStream) -> Result<HttpResponse> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        read_more(stream, &mut buffer)?;
    };

    let (raw_headers, raw_body) = buffer.split_at(header_end);
    let mut raw_body = raw_body[4..].to_vec();
    let headers_text = std::str::from_utf8(raw_headers).context("HTTP headers were not UTF-8")?;
    let mut lines = headers_text.lines();
    let status_line = lines.next().context("HTTP response missing status line")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .context("HTTP status line missing status code")?
        .parse::<u16>()
        .context("HTTP status code was not numeric")?;
    let headers = parse_headers(lines);

    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        let is_sse = headers
            .get("content-type")
            .is_some_and(|value| value.starts_with("text/event-stream"));
        read_chunked_body(stream, &mut raw_body, is_sse)?
    } else if let Some(length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        read_fixed_body(stream, &mut raw_body, length)?
    } else {
        read_body_to_close(stream, raw_body)?
    };

    if !(200..300).contains(&status) {
        let text = String::from_utf8_lossy(&body);
        bail!("HTTP {status}: {text}");
    }

    Ok(HttpResponse { headers, body })
}

fn parse_headers<'a>(lines: impl Iterator<Item = &'a str>) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    headers
}

fn read_fixed_body(
    stream: &mut TcpStream,
    raw_body: &mut Vec<u8>,
    length: usize,
) -> Result<Vec<u8>> {
    if length > MAX_RESPONSE_BYTES {
        bail!("HTTP response body exceeds {} bytes", MAX_RESPONSE_BYTES);
    }
    while raw_body.len() < length {
        read_more(stream, raw_body)?;
    }
    Ok(raw_body[..length].to_vec())
}

fn read_body_to_close(stream: &mut TcpStream, mut body: Vec<u8>) -> Result<Vec<u8>> {
    while body.len() <= MAX_RESPONSE_BYTES {
        let mut chunk = [0_u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(body),
            Ok(count) => body.extend_from_slice(&chunk[..count]),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Ok(body);
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!("HTTP response body exceeds {} bytes", MAX_RESPONSE_BYTES)
}

fn read_chunked_body(
    stream: &mut TcpStream,
    raw_body: &mut Vec<u8>,
    return_after_sse_event: bool,
) -> Result<Vec<u8>> {
    let mut decoded = Vec::new();
    let mut cursor = 0;

    loop {
        while find_crlf(&raw_body[cursor..]).is_none() {
            read_more(stream, raw_body)?;
        }
        let size_line_end =
            find_crlf(&raw_body[cursor..]).context("chunk missing size line")? + cursor;
        let size_line = std::str::from_utf8(&raw_body[cursor..size_line_end])
            .context("chunk size not UTF-8")?;
        let size = usize::from_str_radix(size_line.trim(), 16).context("invalid chunk size")?;
        cursor = size_line_end + 2;

        if size == 0 {
            return Ok(decoded);
        }

        while raw_body.len() < cursor + size + 2 {
            read_more(stream, raw_body)?;
        }
        if decoded.len().saturating_add(size) > MAX_RESPONSE_BYTES {
            bail!("HTTP response body exceeds {} bytes", MAX_RESPONSE_BYTES);
        }
        decoded.extend_from_slice(&raw_body[cursor..cursor + size]);
        cursor += size;

        if raw_body.get(cursor..cursor + 2) != Some(b"\r\n") {
            bail!("chunk missing trailing CRLF");
        }
        cursor += 2;

        if return_after_sse_event && has_sse_json_event(&decoded) {
            return Ok(decoded);
        }
    }
}

fn read_more(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> Result<()> {
    if buffer.len() > MAX_RESPONSE_BYTES {
        bail!("HTTP response exceeds {} bytes", MAX_RESPONSE_BYTES);
    }
    let mut chunk = [0_u8; 8192];
    let count = stream.read(&mut chunk)?;
    if count == 0 {
        bail!("HTTP response ended unexpectedly");
    }
    buffer.extend_from_slice(&chunk[..count]);
    Ok(())
}

fn has_sse_json_event(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    text.split("\n\n").any(|event| {
        event.lines().any(|line| {
            line.strip_prefix("data: ")
                .is_some_and(|payload| !payload.trim().is_empty())
        })
    })
}

#[cfg(test)]
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>> {
    let mut decoded = Vec::new();
    let mut cursor = 0;

    loop {
        let size_line_end = find_crlf(&body[cursor..]).context("chunk missing size line")? + cursor;
        let size_line =
            std::str::from_utf8(&body[cursor..size_line_end]).context("chunk size not UTF-8")?;
        let size = usize::from_str_radix(size_line.trim(), 16).context("invalid chunk size")?;
        cursor = size_line_end + 2;

        if size == 0 {
            break;
        }
        let chunk_end = cursor
            .checked_add(size)
            .filter(|end| *end <= body.len())
            .ok_or_else(|| anyhow!("chunk extends past response body"))?;
        decoded.extend_from_slice(&body[cursor..chunk_end]);
        cursor = chunk_end;

        if body.get(cursor..cursor + 2) != Some(b"\r\n") {
            bail!("chunk missing trailing CRLF");
        }
        cursor += 2;
    }

    Ok(decoded)
}

fn find_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|window| window == b"\r\n")
}

fn parse_sse_or_json(body: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(body).context("MCP response body was not UTF-8")?;
    for line in text.lines() {
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() {
            continue;
        }
        return serde_json::from_str(payload).context("failed to parse MCP SSE payload");
    }
    serde_json::from_str(text).context("failed to parse MCP JSON response")
}

fn ensure_jsonrpc_ok(value: &Value) -> Result<()> {
    if let Some(error) = value.get("error") {
        bail!("MCP error: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{decode_chunked, parse_http_response, parse_sse_or_json};

    #[test]
    fn parses_sse_response_after_empty_heartbeat() {
        let parsed = parse_sse_or_json(
            b"data: \nid: 0\nretry: 3000\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n",
        )
        .unwrap();

        assert_eq!(parsed["result"], json!({"ok": true}));
    }

    #[test]
    fn decodes_chunked_body() {
        let decoded = decode_chunked(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap();
        assert_eq!(decoded, b"hello world");
    }

    #[test]
    fn parses_chunked_http_response_headers_case_insensitively() {
        let response = parse_http_response(
            b"HTTP/1.1 200 OK\r\nMcp-Session-Id: abc\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ndata\r\n0\r\n\r\n",
        )
        .unwrap();

        assert_eq!(response.headers["mcp-session-id"], "abc");
        assert_eq!(response.body, b"data");
    }
}
