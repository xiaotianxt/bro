#!/usr/bin/env python3
"""Run isolated Pi browser subagents and retain raw sessions outside the repo."""

import argparse
import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PI_EXTENSION = REPO_ROOT / "pi-extension" / "src" / "index.ts"
TIMEOUT_SECONDS = 300

SYSTEM_PROMPT = (
    "You are an isolated browser benchmark subagent. Use only the available bro_* browser tools "
    "and facts observed in their results. Prefer the highest-level tool that completes the task. "
    "Use background tabs and clean up flows or owned tabs. Do not ask questions, use prior knowledge, "
    "or perform destructive/account-mutating actions. If evidence is unavailable, report failure "
    "instead of guessing. Return exactly one concise JSON object with keys status, answer, and evidence."
)

MODELS = {
    "spark": {"model": "gpt-5.3-codex-spark", "thinking": "low"},
    "mini": {"model": "gpt-5.4-mini", "thinking": "medium"},
    "sol": {"model": "gpt-5.6-sol", "thinking": "high"},
}

TASKS = {
    "github_release": (
        "Open https://github.com/xiaotianxt/bro/releases/tag/v1.0.1 and determine the release tag, "
        "the exact number of downloadable assets, and every asset filename."
    ),
    "social_batch": (
        "Using one batch operation if available, inspect these four search URLs: "
        "https://www.reddit.com/search/?q=WWDC%202026 ; "
        "https://www.linkedin.com/search/results/content/?keywords=WWDC%202026 ; "
        "https://x.com/search?q=WWDC%202026&src=typed_query ; "
        "https://www.threads.com/search?q=WWDC%202026 . For each site report only the extraction "
        "status, observed text character count, and whether the observed text literally contains WWDC. "
        "Do not infer missing content."
    ),
    "dynamic_loading": (
        "Open https://the-internet.herokuapp.com/dynamic_loading/2, click Start using page interaction, "
        "wait until the asynchronously loaded result is visible, and report the exact result text. "
        "Do not insert or replace page content with JavaScript."
    ),
    "saucedemo": (
        "Open https://www.saucedemo.com/. Log in with username standard_user and password secret_sauce, "
        "sort products by Price (low to high), and report the first product name and displayed price. "
        "Do not add anything to the cart or submit any other action."
    ),
    "network_fetch": (
        "Open https://httpbin.org/html. Use browser network instrumentation to begin observing requests, "
        "then execute a page-side fetch to https://httpbin.org/anything?bro=benchmark. Inspect the matching "
        "network request and its response body, and report the returned bro query parameter value. "
        "Load lower-level bro tools if needed."
    ),
}

MINIMAL_EXPOSURE_EXTENSION = """const KEEP = new Set([
  "bro_search_tools",
  "bro_browser_extract",
  "bro_browser_current_extract",
  "bro_browser_batch_extract",
]);
export default function (pi) {
  pi.on("session_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter(
      (name) => !name.startsWith("bro_") || KEEP.has(name),
    ));
  });
}
"""


def parse_selection(value: str, available: dict[str, object]) -> list[str]:
    if value == "all":
        return list(available)
    selected = [item.strip() for item in value.split(",") if item.strip()]
    unknown = [item for item in selected if item not in available]
    if unknown:
        raise SystemExit(f"unknown selections: {', '.join(unknown)}")
    return selected


def run_one(
    output: Path,
    model_label: str,
    task_name: str,
    exposure: str,
    minimal_extension: Path | None,
) -> None:
    run_id = f"{exposure}__{model_label}__{task_name}"
    run_dir = output / run_id
    meta_path = run_dir / "meta.json"
    if meta_path.exists():
        print(f"SKIP {run_id}", flush=True)
        return

    run_dir.mkdir(parents=True, exist_ok=True)
    session_dir = run_dir / "sessions"
    session_dir.mkdir()
    model = MODELS[model_label]
    command = [
        "pi",
        "--print",
        "--mode",
        "json",
        "--provider",
        "openai-codex",
        "--model",
        model["model"],
        "--thinking",
        model["thinking"],
        "--no-extensions",
        "--extension",
        str(PI_EXTENSION),
        "--no-builtin-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--session-dir",
        str(session_dir),
        "--name",
        f"bro benchmark {run_id}",
        "--system-prompt",
        SYSTEM_PROMPT,
        TASKS[task_name],
    ]
    if minimal_extension is not None:
        extension_index = command.index("--no-builtin-tools")
        command[extension_index:extension_index] = ["--extension", str(minimal_extension)]

    started = time.time()
    timed_out = False
    with (run_dir / "events.jsonl").open("w") as stdout, (run_dir / "stderr.log").open("w") as stderr:
        process = subprocess.Popen(
            command,
            cwd=REPO_ROOT,
            stdout=stdout,
            stderr=stderr,
            text=True,
            start_new_session=True,
            env={**os.environ, "PI_TELEMETRY": "0"},
        )
        try:
            exit_code = process.wait(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                exit_code = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                exit_code = process.wait()

    meta_path.write_text(
        json.dumps(
            {
                "runId": run_id,
                "modelLabel": model_label,
                "model": model["model"],
                "thinking": model["thinking"],
                "task": task_name,
                "exposure": exposure,
                "elapsedSeconds": round(time.time() - started, 3),
                "exitCode": exit_code,
                "timedOut": timed_out,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"DONE {run_id} exit={exit_code} elapsed={time.time() - started:.1f}s",
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(tempfile.gettempdir()) / f"bro-pi-benchmark-{int(time.time())}",
    )
    parser.add_argument("--models", default="all")
    parser.add_argument("--tasks", default="all")
    parser.add_argument("--exposure", choices=("current", "minimal"), default="current")
    args = parser.parse_args()

    models = parse_selection(args.models, MODELS)
    tasks = parse_selection(args.tasks, TASKS)
    args.output.mkdir(parents=True, exist_ok=True)

    minimal_extension = None
    if args.exposure == "minimal":
        minimal_extension = args.output / "_minimal-tools.ts"
        minimal_extension.write_text(MINIMAL_EXPOSURE_EXTENSION)

    for model_label in models:
        for task_name in tasks:
            run_one(args.output, model_label, task_name, args.exposure, minimal_extension)
    print(f"RESULTS {args.output}")


if __name__ == "__main__":
    main()
