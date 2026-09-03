import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BRO_MCP_URL, defaultBroSettingsPath, readBroToken } from "./settings.ts";

const CONNECT_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 5_000;
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

  constructor(options: BroMcpClientOptions = {}) {
    this.endpoint = new URL(options.endpoint?.toString() ?? DEFAULT_BRO_MCP_URL.toString());
    this.settingsPath = options.settingsPath ?? defaultBroSettingsPath();
    assertLoopbackEndpoint(this.endpoint);
  }

  get connected(): boolean {
    return this.connection !== undefined;
  }

  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const { client } = await this.ensureConnected(signal);
    const tools: Tool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        requestOptions(LIST_TIMEOUT_MS, signal),
      );
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
      await this.invalidate(connection);
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error(`bro MCP call failed for ${name}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.connecting) {
      await this.connecting.catch(() => undefined);
    }

    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;

    if (connection.transport.sessionId) {
      await connection.transport.terminateSession().catch(() => undefined);
    }
    await connection.client.close().catch(() => undefined);
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

    const connection = await this.connecting;
    signal?.throwIfAborted();
    return connection;
  }

  private async openConnection(): Promise<Connection> {
    const token = await readBroToken(this.settingsPath);
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    const client = new Client(
      { name: "pi-bro", version: packageVersion() },
      { capabilities: {} },
    );

    try {
      // The SDK transport getter returns `string | undefined` while its Transport
      // interface spells the same state as an optional string. They are runtime-
      // compatible but differ under exactOptionalPropertyTypes.
      await client.connect(transport as unknown as Transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(
        `Unable to connect to bro at ${this.endpoint.origin}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (this.closed) {
      await client.close().catch(() => undefined);
      throw new Error("bro MCP client was closed while connecting");
    }

    const connection = { client, transport };
    this.connection = connection;
    return connection;
  }

  private async invalidate(connection: Connection): Promise<void> {
    if (this.connection !== connection) return;
    this.connection = undefined;
    await connection.client.close().catch(() => undefined);
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
