#!/usr/bin/env python3
"""Aggregate Pi benchmark sessions without copying raw browser content into reports."""

import argparse
import collections
import json
import re
import statistics
from pathlib import Path

EXPECTED_ASSETS = [
    "bro-extension-v1.0.1.zip",
    "bro-v1.0.1-aarch64-apple-darwin.tar.gz",
    "bro-v1.0.1-aarch64-pc-windows-msvc.zip",
    "bro-v1.0.1-aarch64-unknown-linux-gnu.tar.gz",
    "bro-v1.0.1-x86_64-apple-darwin.tar.gz",
    "bro-v1.0.1-x86_64-pc-windows-msvc.zip",
    "bro-v1.0.1-x86_64-unknown-linux-gnu.tar.gz",
    "xiaotianxt-pi-bro-1.0.1.tgz",
]
USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
BILLED_TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite")


def semantic_failure(value: object) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "isError" and item is True:
                return True
            if key == "status" and isinstance(item, str) and item.lower() in {"failed", "error"}:
                return True
            if semantic_failure(item):
                return True
    elif isinstance(value, list):
        return any(semantic_failure(item) for item in value)
    return False


def parse_final_json(text: str) -> object | None:
    candidate = re.sub(r"^```(?:json)?\s*", "", text.strip())
    candidate = re.sub(r"\s*```$", "", candidate)
    try:
        return json.loads(candidate)
    except (TypeError, json.JSONDecodeError):
        return None


def validate_task(task: str, final_text: str, tool_names: list[str]) -> bool:
    lower = final_text.lower()
    compact = final_text.replace(" ", "")
    if task == "github_release":
        return (
            all(asset in final_text for asset in EXPECTED_ASSETS)
            and (
                '"downloadable_asset_count":10' in compact
                or '"downloadable_assets":10' in compact
            )
            and ("source code" in lower or "source-code" in lower or "v1.0.1.zip" in lower)
        )
    if task == "social_batch":
        return (
            all(site in lower for site in ("reddit", "linkedin", "threads"))
            and ("x.com" in lower or '"site": "x"' in lower or '"site":"x"' in lower)
            and "wwdc" in lower
        )
    if task == "dynamic_loading":
        return "hello world" in lower
    if task == "saucedemo":
        return "sauce labs onesie" in lower and "7.99" in final_text
    if task == "network_fetch":
        used_one_shot_capture = "bro_browser_network_capture" in tool_names
        used_raw_capture = (
            "bro_read_network_requests" in tool_names
            and "bro_get_response_body" in tool_names
        )
        return "benchmark" in lower and (used_one_shot_capture or used_raw_capture)
    return False


def parse_run(run_dir: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    meta = json.loads((run_dir / "meta.json").read_text())
    session_files = list((run_dir / "sessions").glob("*.jsonl"))
    usage: collections.Counter[str] = collections.Counter()
    cost: collections.Counter[str] = collections.Counter()
    tool_calls: list[dict[str, object]] = []
    tool_results: list[dict[str, object]] = []
    assistant_turns = 0
    final_text = ""

    if session_files:
        for line in session_files[0].read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "message":
                continue
            message = event.get("message", {})
            role = message.get("role")
            if role == "assistant":
                assistant_turns += 1
                current_usage = message.get("usage", {})
                for key in USAGE_KEYS:
                    value = current_usage.get(key)
                    if isinstance(value, (int, float)):
                        usage[key] += value
                for key, value in current_usage.get("cost", {}).items():
                    if isinstance(value, (int, float)):
                        cost[key] += value
                texts = []
                for item in message.get("content", []):
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "toolCall":
                        tool_calls.append(
                            {
                                "id": item.get("id"),
                                "name": item.get("name"),
                                "arguments": item.get("arguments", {}),
                            }
                        )
                    elif item.get("type") == "text":
                        texts.append(item.get("text", ""))
                if texts:
                    final_text = "\n".join(texts)
            elif role == "toolResult":
                details = message.get("details")
                tool_results.append(
                    {
                        "id": message.get("toolCallId"),
                        "name": message.get("toolName"),
                        "failed": bool(message.get("isError")) or semantic_failure(details),
                        "outerError": bool(message.get("isError")),
                    }
                )

    tool_names = [str(call["name"]) for call in tool_calls if call.get("name")]
    parsed_final = parse_final_json(final_text)
    reported_status = parsed_final.get("status") if isinstance(parsed_final, dict) else None
    task_success = (
        meta.get("exitCode") == 0
        and not meta.get("timedOut")
        and reported_status in {"ok", "success"}
        and validate_task(str(meta["task"]), final_text, tool_names)
    )
    return (
        {
            **meta,
            "assistantTurns": assistant_turns,
            "toolCallCount": len(tool_calls),
            "failedToolCalls": sum(bool(result["failed"]) for result in tool_results),
            "outerToolErrors": sum(bool(result["outerError"]) for result in tool_results),
            "toolNames": tool_names,
            "usage": dict(usage),
            "billedTokens": sum(usage[key] for key in BILLED_TOKEN_KEYS),
            "cost": dict(cost),
            "taskSuccess": task_success,
        },
        tool_results,
    )


def summarize_group(runs: list[dict[str, object]]) -> dict[str, object]:
    return {
        "runs": len(runs),
        "successes": sum(bool(run["taskSuccess"]) for run in runs),
        "successRate": sum(bool(run["taskSuccess"]) for run in runs) / len(runs),
        "meanSeconds": statistics.mean(float(run["elapsedSeconds"]) for run in runs),
        "medianSeconds": statistics.median(float(run["elapsedSeconds"]) for run in runs),
        "meanToolCalls": statistics.mean(int(run["toolCallCount"]) for run in runs),
        "medianToolCalls": statistics.median(int(run["toolCallCount"]) for run in runs),
        "meanBilledTokens": statistics.mean(int(run["billedTokens"]) for run in runs),
        "medianBilledTokens": statistics.median(int(run["billedTokens"]) for run in runs),
        "totalCost": sum(float(run["cost"].get("total", 0)) for run in runs),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    runs = []
    all_tool_results = []
    for run_dir in sorted(path for path in args.results.iterdir() if path.is_dir()):
        if not (run_dir / "meta.json").exists():
            continue
        run, tool_results = parse_run(run_dir)
        runs.append(run)
        all_tool_results.extend(tool_results)

    model_summary = {
        label: summarize_group([run for run in runs if run["modelLabel"] == label])
        for label in sorted({str(run["modelLabel"]) for run in runs})
    }
    task_summary = {
        task: summarize_group([run for run in runs if run["task"] == task])
        for task in sorted({str(run["task"]) for run in runs})
    }
    tool_summary = {}
    for name in sorted({str(result["name"]) for result in all_tool_results if result.get("name")}):
        grouped = [result for result in all_tool_results if result["name"] == name]
        failures = sum(bool(result["failed"]) for result in grouped)
        tool_summary[name] = {
            "calls": len(grouped),
            "failures": failures,
            "outerErrors": sum(bool(result["outerError"]) for result in grouped),
            "successRate": 1 - failures / len(grouped),
        }

    report = {
        "runCount": len(runs),
        "models": model_summary,
        "tasks": task_summary,
        "tools": tool_summary,
        "runs": runs,
    }
    rendered = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
