import { afterEach, describe, expect, it, vi } from "vitest";
import { BroMcpClient } from "../src/client.ts";
vi.mock("../src/settings.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/settings.ts")>(),
  readBroToken: async () => "offline-test-token",
}));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result }, { headers: { "mcp-session-id": "offline-session" } });
function server(overrides: (body: any, init: RequestInit) => Promise<Response> | Response | undefined = () => undefined) {
  let initializations = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit = {}) => {
    if (init.method === "GET") return new Response(null, { status: 405 });
    const body = init.body ? JSON.parse(String(init.body)) : { method: init.method };
    const override = overrides(body, init);
    if (override) return override;
    if (body.method === "initialize") {
      initializations++;
      return response(body.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "offline", version: "1" } });
    }
    if (body.method === "tools/list") return response(body.id, { tools: [] });
    if (body.method === "tools/call") return response(body.id, { content: [{ type: "text", text: "ok" }] });
    return new Response(null, { status: 202 });
  }));
  return () => initializations;
}

describe("shared MCP connection ownership", () => {
  it("abort and request-level HTTP failures do not kill a sibling or recreate the connection", async () => {
    const entered = deferred<void>();
    const held = deferred<Response>();
    const cancelling = deferred<void>();
    let heldId: unknown;
    let transportSignal: AbortSignal | null | undefined;
    const count = server((body, init) => {
      if (body.params?.name === "held") { heldId = body.id; transportSignal = init.signal; entered.resolve(); return held.promise; }
      if (body.params?.name === "cancelled") { cancelling.resolve(); return new Promise<Response>(() => {}); }
      if (body.params?.name === "error") return new Response("request failed", { status: 500 });
    });
    const client = new BroMcpClient();
    await client.listTools();
    const sibling = client.callTool("held", {});
    await entered.promise;
    const controller = new AbortController();
    const reason = new Error("cancel this request");
    const cancelled = client.callTool("cancelled", {}, controller.signal);
    await cancelling.promise;
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    await expect(client.callTool("error", {})).rejects.toMatchObject({ cause: { code: 500 } });
    expect(transportSignal?.aborted).toBe(false);
    held.resolve(response(heldId, { content: [{ type: "text", text: "sibling survived" }] }));
    await expect(sibling).resolves.toMatchObject({ content: [{ text: "sibling survived" }] });
    await client.callTool("next", {});
    expect(count()).toBe(1);
    await client.close();
  });

  it("expired sessions reconnect on the next action without replay", async () => {
    let calls = 0;
    const count = server(body => {
      if (body.params?.name === "expired") { calls++; return new Response("expired", { status: 404 }); }
    });
    const client = new BroMcpClient();
    await expect(client.callTool("expired", {})).rejects.toMatchObject({ cause: { code: 404 } });
    await client.callTool("next", {});
    expect(calls).toBe(1);
    expect(count()).toBe(2);
    await client.close();
  });

  it("shutdown bounds DELETE and aborts the actual transport request", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    let signal: AbortSignal | null | undefined;
    server((body, init) => {
      if (body.method === "DELETE") { signal = init.signal; entered.resolve(); return new Promise<Response>(() => {}); }
    });
    const client = new BroMcpClient();
    await client.listTools();
    const close = client.close();
    expect(client.close()).toBe(close);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await close;
    expect(signal?.aborted).toBe(true);
    await expect(client.listTools()).rejects.toThrow("closed");
  });

  it("the whole connect handshake is bounded, including initialized notification", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    let signal: AbortSignal | null | undefined;
    server((body, init) => {
      if (body.method === "notifications/initialized") { signal = init.signal; entered.resolve(); return new Promise<Response>(() => {}); }
    });
    const client = new BroMcpClient();
    const connecting = expect(client.listTools()).rejects.toThrow(/deadline|closed/);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(3000);
    await connecting;
    expect(signal?.aborted).toBe(true);
    await client.close();
    expect(client.connected).toBe(false);
  });
});
