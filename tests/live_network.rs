use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use bro::{client, settings::Settings};
use serde_json::{json, Value};

const PORT: u16 = 3500;

#[test]
#[ignore]
fn captures_triggered_request_and_response_body_in_one_call() {
    let settings = Settings::load_or_create().expect("settings should load");
    let response = client::call_tool(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), PORT),
        settings.token(),
        "browser.network.capture",
        json!({
            "url": "https://httpbin.org/html",
            "code": "fetch('/anything?bro=live-network-test', {cache: 'no-store'}).then(r => r.json())",
            "urlIncludes": "/anything?bro=live-network-test",
            "includeResponseBodies": true,
            "cleanup": true,
            "active": false
        }),
    )
    .expect("network capture should complete");
    let result = structured(&response);

    assert_eq!(result["matchedRequests"], 1);
    assert_eq!(result["timedOut"], false);
    assert_eq!(result["requests"][0]["status"], 200);
    let body = result["requests"][0]["body"]
        .as_str()
        .expect("response body should be text");
    let body = serde_json::from_str::<Value>(body).expect("response body should be JSON");
    assert_eq!(body["args"]["bro"], "live-network-test");
}

fn structured(response: &Value) -> &Value {
    if let Some(value) = response.pointer("/result/structuredContent") {
        return value;
    }
    if let Some(value) = response.pointer("/result/structured_content") {
        return value;
    }
    panic!("response did not include structured content: {response}");
}
