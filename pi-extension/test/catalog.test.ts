import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  buildBroCatalog,
  mapMcpToolResult,
  normalizeBroToolName,
  prepareBroArguments,
  searchBroCatalog,
  throwIfMcpToolFailed,
} from "../src/catalog.ts";

function tool(name: string, description = "", properties: string[] = []): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(properties.map((property) => [property, { type: "string" }])),
    },
  };
}

describe("bro tool catalog", () => {
  it("normalizes names into a collision-resistant Pi namespace", () => {
    expect(normalizeBroToolName("browser.batch.extract")).toBe("bro_browser_batch_extract");
    expect(normalizeBroToolName("find")).toBe("bro_find");
  });

  it("omits server-owned internal tools from Pi registration", () => {
    const internal = {
      ...tool("agent_done"),
      _meta: { "bro/piVisibility": "internal" },
    } as Tool;

    const lifecycle = {
      ...tool("tabs_finalize"),
      _meta: { "bro/capability": "tabs" },
    } as Tool;

    expect(buildBroCatalog([internal], [])).toEqual([]);
    expect(buildBroCatalog([lifecycle], []).map((entry) => entry.piName)).toEqual([
      "bro_tabs_finalize",
    ]);
  });

  it("rejects normalized collisions before registering tools", () => {
    expect(() => buildBroCatalog([tool("a.b"), tool("a_b")], [])).toThrow(
      "bro tool name collision",
    );
  });

  it("rejects collisions with an existing Pi tool", () => {
    expect(() => buildBroCatalog([tool("find")], ["bro_find"])).toThrow(
      "Pi tool name already registered: bro_find",
    );
  });

  it("loads the complete flow pack for interaction intent", () => {
    const flowTools = [
      tool("browser.flow.start"),
      tool("browser.flow.observe"),
      tool("browser.flow.act"),
      tool("browser.flow.finish"),
    ].map((entry) => ({
      ...entry,
      _meta: { "bro/capability": "interaction" },
    })) as Tool[];
    const catalog = buildBroCatalog(flowTools, []);

    expect(
      searchBroCatalog(catalog, "interact with a multi-step page", 8).map(
        (entry) => entry.piName,
      ),
    ).toEqual([
      "bro_browser_flow_start",
      "bro_browser_flow_observe",
      "bro_browser_flow_act",
      "bro_browser_flow_finish",
    ]);
  });

  it("loads a complete server-owned capability pack", () => {
    const scripts = [
      tool("userscripts_register"),
      tool("userscripts_unregister"),
      tool("userscripts_list"),
    ].map((entry) => ({
      ...entry,
      _meta: { "bro/capability": "userscripts" },
    })) as Tool[];
    const catalog = buildBroCatalog(scripts, []);

    expect(
      searchBroCatalog(catalog, "persistent automation", 8).map((entry) => entry.piName),
    ).toEqual([
      "bro_userscripts_register",
      "bro_userscripts_unregister",
      "bro_userscripts_list",
    ]);
  });

  it("searches names, descriptions, and parameter names", () => {
    const catalog = buildBroCatalog(
      [
        tool("read_network_requests", "Inspect captured requests", ["urlPattern"]),
        tool("tabs_close", "Close a browser tab", ["tabId"]),
      ],
      [],
    );

    expect(searchBroCatalog(catalog, "network", 5).map((entry) => entry.piName)).toEqual([
      "bro_read_network_requests",
    ]);
    expect(searchBroCatalog(catalog, "url pattern", 5)[0]?.piName).toBe(
      "bro_read_network_requests",
    );
  });
});

describe("prepareBroArguments", () => {
  it("injects the Pi session into tab lifecycle tools", () => {
    expect(
      prepareBroArguments("tabs_create", { url: "https://example.com" }, { id: "session-1" }),
    ).toEqual({ url: "https://example.com", sessionId: "session-1" });
  });

  it("preserves an explicit session id", () => {
    expect(
      prepareBroArguments("tabs_finalize", { sessionId: "explicit" }, { id: "session-1" }),
    ).toEqual({ sessionId: "explicit" });
  });

  it("does not replace browser flow ids with the Pi session id", () => {
    expect(
      prepareBroArguments("browser.flow.finish", { sessionId: "flow-1" }, { id: "session-1" }),
    ).toEqual({ sessionId: "flow-1" });
  });

  it("adds the current display name to session_name", () => {
    expect(prepareBroArguments("session_name", {}, { id: "session-1", name: "Review" })).toEqual({
      sessionId: "session-1",
      name: "Review",
    });
  });
});

describe("MCP result mapping", () => {
  it("keeps text, images, and structured content", () => {
    const result = {
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      structuredContent: { tabId: 42 },
    } as CallToolResult;

    expect(mapMcpToolResult("computer", result)).toEqual({
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      details: {
        adapter: "bro",
        upstreamTool: "computer",
        structuredContent: { tabId: 42 },
        truncated: false,
        omittedImages: 0,
      },
    });
  });

  it("uses structured content when MCP returned no text", () => {
    const result = {
      content: [],
      structuredContent: { status: "ok" },
    } as unknown as CallToolResult;

    expect(mapMcpToolResult("browser.extract", result).content[0]).toEqual({
      type: "text",
      text: '{\n  "status": "ok"\n}',
    });
  });

  it("throws for MCP tool errors so Pi records a failed tool result", () => {
    const result = {
      content: [{ type: "text", text: "No browser connected" }],
      isError: true,
    } as CallToolResult;

    expect(() => throwIfMcpToolFailed("tabs_context", result)).toThrow(
      "tabs_context: No browser connected",
    );
  });

  it("bounds large text output", () => {
    const result = {
      content: [{ type: "text", text: "x".repeat(60_000) }],
    } as CallToolResult;

    const mapped = mapMcpToolResult("get_page_text", result);

    expect(mapped.details.truncated).toBe(true);
    expect(mapped.content[0]?.type).toBe("text");
    if (mapped.content[0]?.type === "text") {
      expect(Buffer.byteLength(mapped.content[0].text)).toBeLessThan(52_000);
    }
  });
});
