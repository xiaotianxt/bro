import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BRO_MCP_URL, defaultBroSettingsPath, readBroToken } from "./settings.ts";

const CONNECT_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 1_000;
const TOOL_TIMEOUT_MS = 120_000;

interface BroMcpClientOptions {
  endpoint?: URL;
  settingsPath?: string;
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export interface BroToolClient {
  readonly connected: boolean;
  listTools(signal?: AbortSignal): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class BroMcpClient implements BroToolClient {
  private readonly endpoint: URL;
  private readonly settingsPath: string;
  private connection: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private closed = false;
  private opening: Connection | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: BroMcpClientOptions = {}) {
    this.endpoint = new URL(options.endpoint?.toString() ?? DEFAULT_BRO_MCP_URL.toString());
    this.settingsPath = options.settingsPath ?? defaultBroSettingsPath();
    assertLoopbackEndpoint(this.endpoint);
  }

  get connected(): boolean {
    return this.connection !== undefined;
  }

  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const connection = await this.ensureConnected(signal);
    const { client } = connection;
    const tools: Tool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        requestOptions(LIST_TIMEOUT_MS, signal),
      ).catch(async (error: unknown) => {
        if (signal?.aborted) throw signal.reason;
        await this.invalidateExpiredSession(connection, error);
        throw error;
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = TOOL_TIMEOUT_MS,
  ): Promise<CallToolResult> {
    const connection = await this.ensureConnected(signal);

    try {
      return (await connection.client.callTool(
        { name, arguments: args },
        undefined,
        requestOptions(timeoutMs, signal),
      )) as CallToolResult;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      await this.invalidateExpiredSession(connection, error);
      throw new Error(`bro MCP call failed for ${name}: ${errorMessage(error)}`, { cause: error });
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const opening = this.opening;
    const connection = this.connection;
    this.connection = undefined;
    this.closing = (async () => {
      if (opening) await opening.client.close().catch(() => undefined);
      if (!connection) return;
      try {
        if (connection.transport.sessionId) {
          await withDeadline(connection.transport.terminateSession(), CLOSE_TIMEOUT_MS,
            () => { void connection.client.close().catch(() => undefined); });
        }
      } catch {
        // Best-effort server cleanup; closing below aborts the actual pending HTTP work.
      } finally {
        await connection.client.close().catch(() => undefined);
      }
    })();
    return this.closing;
  }

  private async ensureConnected(signal?: AbortSignal): Promise<Connection> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("bro MCP client is closed");
    if (this.connection) return this.connection;

    if (!this.connecting) {
      this.connecting = this.openConnection().finally(() => {
        this.connecting = undefined;
      });
    }

    const connection = await waitForConnection(this.connecting, signal);
    signal?.throwIfAborted();
    if (this.closed || this.connection !== connection) throw new Error("bro MCP connection closed");
    return connection;
  }

  private async openConnection(): Promise<Connection> {
    const token = await readBroToken(this.settingsPath);
    if (this.closed) throw new Error("bro MCP client is closed");
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    const client = new Client(
      { name: "pi-bro", version: packageVersion() },
      { capabilities: {} },
    );

    const connection = { client, transport };
    this.opening = connection;
    let disconnected = false;
    client.onclose = () => {
      disconnected = true;
      if (this.connection === connection) this.connection = undefined;
    };
    try {
      // The SDK transport getter returns `string | undefined` while its Transport
      // interface spells the same state as an optional string. They are runtime-
      // compatible but differ under exactOptionalPropertyTypes.
      await withDeadline(client.connect(transport as unknown as Transport, { timeout: CONNECT_TIMEOUT_MS }),
        CONNECT_TIMEOUT_MS, () => { void client.close().catch(() => undefined); });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(
        `Unable to connect to bro at ${this.endpoint.origin}: ${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      if (this.opening === connection) this.opening = undefined;
    }

    if (this.closed || disconnected) {
      await client.close().catch(() => undefined);
      throw new Error("bro MCP client was closed while connecting");
    }

    this.connection = connection;
    return connection;
  }

  private async invalidateExpiredSession(connection: Connection, error: unknown): Promise<void> {
    // Request cancellation, timeout, JSON-RPC errors and transient HTTP failures
    // are not evidence that the shared transport is dead. Never replay actions.
    if (!(error instanceof StreamableHTTPError) || error.code !== 404 || !connection.transport.sessionId) return;
    if (this.connection !== connection) return;
    this.connection = undefined;
    await connection.client.close().catch(() => undefined);
  }
}

async function withDeadline<T>(work: Promise<T>, milliseconds: number, cancel: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancel(); reject(new Error("bro MCP lifecycle deadline exceeded")); }, milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForConnection(work: Promise<Connection>, signal?: AbortSignal): Promise<Connection> {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestOptions(timeout: number, signal?: AbortSignal) {
  return signal ? { timeout, signal } : { timeout };
}

function assertLoopbackEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("bro MCP endpoint must use http://127.0.0.1");
  }
}
