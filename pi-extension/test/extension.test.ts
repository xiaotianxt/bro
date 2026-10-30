import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { BRO_SEARCH_TOOL_NAME, installBroPiExtension } from "../src/index.ts";
import type { BroToolClient } from "../src/client.ts";
import type { PiExtensionApi, PiExtensionContext } from "../src/pi-types.ts";

interface RegisteredTool {
  name: string;
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function upstreamTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  };
}

function createPiHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  let activeTools = ["bash"];

  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    getAllTools() {
      return [...tools.values()];
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as PiExtensionApi;

  async function emit(event: string, payload: unknown, context: unknown) {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload as never, context as never);
    }
  }

  return { pi, tools, emit, activeTools: () => activeTools };
}

function createContext(): PiExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getSessionName: () => "Browser review",
      getBranch: () => [],
    },
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as unknown as PiExtensionContext;
}

describe("bro Pi extension", () => {
  it("discovers native schemas and keeps low-level tools inactive", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const close = vi.fn(async () => undefined);
    const client: BroToolClient = {
      connected: true,
      async listTools() {
        return [
          upstreamTool("browser.extract"),
          upstreamTool("browser.network.capture"),
          upstreamTool("javascript_tool"),
          upstreamTool("session_name"),
          upstreamTool("tabs_finalize"),
        ];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: name === "browser.extract" ? { status: "ok" } : undefined,
        } as CallToolResult;
      },
      close,
    };
    const harness = createPiHarness();
    const context = createContext();
    installBroPiExtension(harness.pi, { createClient: () => client });

    await harness.emit("session_start", { reason: "startup" }, context);

    expect(harness.activeTools()).toContain("bash");
    expect(harness.activeTools()).toContain(BRO_SEARCH_TOOL_NAME);
    expect(harness.activeTools()).toContain("bro_browser_extract");
    expect(harness.activeTools()).toContain("bro_browser_network_capture");
    expect(harness.activeTools()).not.toContain("bro_javascript_tool");
    expect(calls[0]).toEqual({
      name: "session_name",
      args: { sessionId: "pi-session-1", name: "Browser review" },
    });

    const extract = harness.tools.get("bro_browser_extract");
    const result = await extract?.execute("call-1", {}, undefined, undefined, context);
    expect(result).toMatchObject({
      details: {
        adapter: "bro",
        upstreamTool: "browser.extract",
        structuredContent: { status: "ok" },
      },
    });

    await harness.emit("session_shutdown", { reason: "quit" }, context);
    expect(calls.some((call) => call.name === "tabs_finalize")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses server-owned defaults, supplies ownership, and restores targets across reload for cleanup", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = ["browser.open", "browser.observe", "browser.act", "browser.close", "browser.flow.start", "browser.flow.finish"].map((name) => ({
      ...upstreamTool(name), _meta: { "bro/default": !name.startsWith("browser.flow.") },
    }));
    const client: BroToolClient = {
      connected: true,
      async listTools() { return tools; },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "ok" }], structuredContent: { targetId: "target-1", status: "ok" } } as CallToolResult;
      },
      close: vi.fn(async () => {}),
    };
    const first = createPiHarness();
    const context = createContext();
    installBroPiExtension(first.pi, { createClient: () => client });
    await first.emit("session_start", {}, context);
    expect(first.activeTools()).toContain("bro_browser_open");
    expect(first.activeTools()).not.toContain("bro_browser_flow_start");
    const open = first.tools.get("bro_browser_open")!;
    const args = open.prepareArguments!({ url: "https://example.test" });
    expect(args).toEqual({ url: "https://example.test", ownerSessionId: "pi-session-1", label: "Browser review" });
    const opened = await open.execute("open", args, undefined, undefined, context) as { details: unknown };
    await first.emit("session_shutdown", { reason: "reload" }, context);
    expect(calls.some((call) => call.name === "browser.close")).toBe(false);
    const second = createPiHarness();
    const resumed = createContext();
    resumed.sessionManager.getBranch = () => [{ type: "message", message: { role: "toolResult", details: opened.details } }];
    installBroPiExtension(second.pi, { createClient: () => client });
    await second.emit("session_start", {}, resumed);
    await second.emit("session_shutdown", { reason: "quit" }, resumed);
    expect(calls.filter((call) => call.name === "browser.close")).toEqual([{ name: "browser.close", args: { targetId: "target-1" } }]);
    expect(calls.at(-1)?.name).toBe("tabs_finalize");
  });

  it("enables matching low-level tools additively", async () => {
    const client: BroToolClient = {
      connected: true,
      async listTools() {
        return [upstreamTool("browser.extract"), upstreamTool("read_network_requests")];
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] } as CallToolResult;
      },
      async close() {},
    };
    const harness = createPiHarness();
    const context = createContext();
    installBroPiExtension(harness.pi, { createClient: () => client });
    await harness.emit("session_start", { reason: "startup" }, context);

    const loader = harness.tools.get(BRO_SEARCH_TOOL_NAME);
    await loader?.execute("call-1", { query: "network", limit: 3 }, undefined, undefined, context);

    expect(harness.activeTools()).toContain("bash");
    expect(harness.activeTools()).toContain("bro_browser_extract");
    expect(harness.activeTools()).toContain("bro_read_network_requests");
  });
});
