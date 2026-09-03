use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use bro::{client, settings::Settings};
use serde_json::{json, Value};

const PORT: u16 = 3500;

struct LiveCase {
    id: &'static str,
    url: &'static str,
    expected_text: &'static [&'static str],
    expected_links: &'static [&'static str],
}

#[test]
#[ignore]
fn extracts_dynamic_social_search_pages() {
    let cases = [
        LiveCase {
            id: "reddit",
            url: "https://www.reddit.com/search/?q=WWDC%202026",
            expected_text: &["WWDC 2026", "r/apple"],
            expected_links: &["reddit.com/r/apple/comments/"],
        },
        LiveCase {
            id: "linkedin",
            url: "https://www.linkedin.com/search/results/content/?keywords=WWDC%202026",
            expected_text: &["WWDC 2026", "Apple"],
            expected_links: &["linkedin.com/"],
        },
        LiveCase {
            id: "x",
            url: "https://x.com/search?q=WWDC%202026&src=typed_query",
            expected_text: &["WWDC"],
            expected_links: &["x.com/"],
        },
        LiveCase {
            id: "threads",
            url: "https://www.threads.com/search?q=WWDC%202026",
            expected_text: &["WWDC", "Threads"],
            expected_links: &["threads.com/@"],
        },
    ];

    let response = call_extract_batch(&cases);
    let results = structured(&response)["results"]
        .as_array()
        .expect("browser.batch.extract response should include results[]");

    assert_eq!(results.len(), cases.len(), "unexpected result count");

    for case in cases {
        let result = results
            .iter()
            .find(|result| result["id"] == case.id)
            .unwrap_or_else(|| panic!("missing result for {}", case.id));

        assert_eq!(
            result["status"], "ok",
            "{} should extract successfully; diagnostics={}",
            case.id, result["diagnostics"]
        );
        assert_eq!(
            result["diagnostics"]["source"], "extract_page",
            "{} should use browser-side extract_page readiness",
            case.id
        );
        assert_eq!(
            result["diagnostics"]["ready"], true,
            "{} should reach content readiness",
            case.id
        );

        let text = result["text"]
            .as_str()
            .unwrap_or_else(|| panic!("{} result text should be a string", case.id));
        for expected in case.expected_text {
            assert!(
                text.contains(expected),
                "{} text should contain {:?}; text prefix={:?}",
                case.id,
                expected,
                text.chars().take(240).collect::<String>()
            );
        }

        let links = result["links"]
            .as_array()
            .unwrap_or_else(|| panic!("{} result links should be an array", case.id));
        let link_urls = links
            .iter()
            .filter_map(|link| link["url"].as_str())
            .collect::<Vec<_>>();
        for expected in case.expected_links {
            assert!(
                link_urls.iter().any(|url| url.contains(expected)),
                "{} should include a link containing {:?}; urls={:?}",
                case.id,
                expected,
                link_urls
            );
        }

        eprintln!(
            "{} ok: {} chars, {} links, reason={}",
            case.id,
            text.chars().count(),
            links.len(),
            result["diagnostics"]["extensionReason"]
        );
    }
}

fn call_extract_batch(cases: &[LiveCase]) -> Value {
    let settings = Settings::load_or_create().expect("settings should load");
    let inputs = cases
        .iter()
        .map(|case| json!({ "id": case.id, "url": case.url }))
        .collect::<Vec<_>>();

    client::call_tool(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), PORT),
        settings.token(),
        "browser.batch.extract",
        json!({
            "inputs": inputs,
            "concurrency": 4,
            "maxChars": 3000,
            "maxLinks": 20,
            "includeA11y": false,
            "includeLinks": true,
            "cleanup": true
        }),
    )
    .expect("browser.batch.extract live call should succeed")
}

fn structured(response: &Value) -> &Value {
    if response.get("results").is_some() {
        return response;
    }
    if let Some(value) = response.pointer("/result/structuredContent") {
        return value;
    }
    if let Some(value) = response.pointer("/result/structured_content") {
        return value;
    }
    panic!("response did not include structured content: {response}");
}
