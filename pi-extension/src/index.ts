import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import {
  buildBroCatalog,
  type BroCatalogTool,
  type BroSessionDescriptor,
  type BroToolDetails,
  DEFAULT_ACTIVE_UPSTREAM_TOOLS,
  mapMcpToolResult,
  prepareBroArguments,
  searchBroCatalog,
  throwIfMcpToolFailed,
} from "./catalog.ts";
import { BroMcpClient, type BroToolClient } from "./client.ts";
import type { PiExtensionApi, PiExtensionContext } from "./pi-types.ts";

export const BRO_SEARCH_TOOL_NAME = "bro_search_tools";
const CLEANUP_TIMEOUT_MS = 3_000;

interface RuntimeState {
  client: BroToolClient;
  session: BroSessionDescriptor;
  activeFlowIds: Set<string>;
  catalog: BroCatalogTool[] | undefined;
  catalogPromise: Promise<BroCatalogTool[]> | undefined;
}

interface BroPiExtensionDependencies {
  createClient?: () => BroToolClient;
}

export function installBroPiExtension(
  pi: PiExtensionApi,
  dependencies: BroPiExtensionDependencies = {},
): void {
  const createClient = dependencies.createClient ?? (() => new BroMcpClient());
  let runtime: RuntimeState | undefined;

  pi.registerTool({
    name: BRO_SEARCH_TOOL_NAME,
    label: "bro: Search Tools",
    description:
      "Find and enable bro browser tools relevant to a task. Use this for tabs, JavaScript, page interaction, console, network, uploads, shortcuts, user scripts, or diagnostics when the needed bro_* tool is not already active.",
    promptSnippet: "Find and enable additional bro browser tools on demand",
    promptGuidelines: [
      "Use bro_search_tools when a browser task needs a bro capability that is not currently active.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Browser capability or task to find tools for.",
        minLength: 1,
        maxLength: 500,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum tools to enable. Defaults to 5.",
          minimum: 1,
          maximum: 8,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const current = requireRuntime(runtime);
      let catalog: BroCatalogTool[];
      try {
        catalog = await ensureCatalog(pi, current, signal);
        ctx.ui.setStatus("bro", undefined);
      } catch (error) {
        ctx.ui.setStatus("bro", "bro disconnected");
        throw error;
      }

      const matches = searchBroCatalog(catalog, params.query, params.limit ?? 5);
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const added = matches.map((tool) => tool.piName).filter((name) => !activeSet.has(name));
      if (added.length > 0) {
        pi.setActiveTools(unique([...active, ...added]));
      }

      const matchedNames = matches.map((tool) => tool.piName);
      const text =
        matchedNames.length === 0
          ? `No bro tools matched: ${params.query}`
          : added.length > 0
            ? `Enabled bro tools: ${added.join(", ")}`
            : `Matching bro tools are already active: ${matchedNames.join(", ")}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { matches: matchedNames, added },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const session = sessionDescriptor(ctx);
    const current: RuntimeState = {
      client: createClient(),
      session,
      activeFlowIds: restoreActiveFlowIds(ctx),
      catalog: undefined,
      catalogPromise: undefined,
    };
    runtime = current;

    try {
      await ensureCatalog(pi, current);
      await syncSessionName(current);
      ctx.ui.setStatus("bro", undefined);
    } catch (error) {
      ctx.ui.setStatus("bro", "bro disconnected");
      ctx.ui.notify(
        `bro Pi tools are unavailable: ${errorMessage(error)}. bro_search_tools will retry on demand.`,
        "warning",
      );
    }
  });

  pi.on("session_info_changed", async (event, ctx) => {
    if (!runtime) return;
    runtime.session = {
      ...runtime.session,
      name: displaySessionName(event.name, runtime.session.id),
    };
    try {
      await syncSessionName(runtime);
      ctx.ui.setStatus("bro", undefined);
    } catch {
      ctx.ui.setStatus("bro", "bro disconnected");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const current = runtime;
    runtime = undefined;
    ctx.ui.setStatus("bro", undefined);
    if (!current) return;

    if (event.reason !== "reload") {
      await cleanupBrowserState(current);
    }
    await current.client.close();
  });

  async function ensureCatalog(
    extension: PiExtensionApi,
    current: RuntimeState,
    signal?: AbortSignal,
  ): Promise<BroCatalogTool[]> {
    if (current.catalog) return current.catalog;
    if (current.catalogPromise) return current.catalogPromise;

    current.catalogPromise = discoverAndRegister(extension, current, signal).finally(() => {
      current.catalogPromise = undefined;
    });
    return current.catalogPromise;
  }

  async function discoverAndRegister(
    extension: PiExtensionApi,
    current: RuntimeState,
    signal?: AbortSignal,
  ): Promise<BroCatalogTool[]> {
    const upstreamTools = await current.client.listTools(signal);
    const existingNames = extension.getAllTools().map((tool) => tool.name);
    const catalog = buildBroCatalog(upstreamTools, existingNames);

    for (const entry of catalog) {
      registerUpstreamTool(extension, entry);
    }

    current.catalog = catalog;
    exposeDefaultTools(extension, catalog);
    return catalog;
  }

  function registerUpstreamTool(extension: PiExtensionApi, entry: BroCatalogTool): void {
    const { upstream, piName } = entry;
    extension.registerTool({
      name: piName,
      label: `bro: ${upstream.name}`,
      description: upstream.description ?? `Call the bro MCP tool ${upstream.name}.`,
      parameters: Type.Unsafe(upstream.inputSchema),
      prepareArguments(args) {
        const session = runtime?.session ?? {};
        return prepareBroArguments(upstream.name, args, session);
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const current = requireRuntime(runtime);
        try {
          const result = await current.client.callTool(
            upstream.name,
            asArguments(params),
            signal,
          );
          throwIfMcpToolFailed(upstream.name, result);
          trackFlowResult(current, upstream.name, params, result);
          ctx.ui.setStatus("bro", undefined);
          return mapMcpToolResult(upstream.name, result);
        } catch (error) {
          if (!signal?.aborted) {
            ctx.ui.setStatus("bro", current.client.connected ? undefined : "bro disconnected");
          }
          throw error;
        }
      },
    });
  }
}

export default function broPiExtension(pi: PiExtensionApi): void {
  installBroPiExtension(pi);
}

function exposeDefaultTools(pi: PiExtensionApi, catalog: BroCatalogTool[]): void {
  const broToolNames = new Set(catalog.map((tool) => tool.piName));
  const preserved = pi.getActiveTools().filter((name) => !broToolNames.has(name));
  const defaults = catalog
    .filter((tool) => DEFAULT_ACTIVE_UPSTREAM_TOOLS.has(tool.upstream.name))
    .map((tool) => tool.piName);
  pi.setActiveTools(unique([...preserved, BRO_SEARCH_TOOL_NAME, ...defaults]));
}

async function syncSessionName(runtime: RuntimeState): Promise<void> {
  if (!runtime.session.id || !runtime.session.name) return;
  if (!runtime.catalog?.some((tool) => tool.upstream.name === "session_name")) return;

  await runtime.client.callTool(
    "session_name",
    { sessionId: runtime.session.id, name: runtime.session.name },
    undefined,
    5_000,
  );
}

async function cleanupBrowserState(runtime: RuntimeState): Promise<void> {
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  const cleanupCalls = [...runtime.activeFlowIds].map((sessionId) =>
    runtime.client.callTool("browser.flow.finish", { sessionId }, signal, CLEANUP_TIMEOUT_MS),
  );
  if (runtime.session.id) {
    cleanupCalls.push(
      runtime.client.callTool(
        "tabs_finalize",
        { sessionId: runtime.session.id },
        signal,
        CLEANUP_TIMEOUT_MS,
      ),
    );
  }
  await Promise.allSettled(cleanupCalls);
}

function trackFlowResult(
  runtime: RuntimeState,
  upstreamName: string,
  params: unknown,
  result: CallToolResult,
): void {
  if (upstreamName === "browser.flow.start") {
    const sessionId = stringProperty(result.structuredContent, "sessionId");
    if (sessionId) runtime.activeFlowIds.add(sessionId);
    return;
  }

  if (upstreamName === "browser.flow.finish") {
    const sessionId =
      stringProperty(result.structuredContent, "sessionId") ?? stringProperty(params, "sessionId");
    if (sessionId) runtime.activeFlowIds.delete(sessionId);
  }
}

function restoreActiveFlowIds(ctx: PiExtensionContext): Set<string> {
  const active = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    const details = broDetailsFromBranchEntry(entry);
    if (!details) continue;
    const sessionId = stringProperty(details.structuredContent, "sessionId");
    if (!sessionId) continue;

    if (details.upstreamTool === "browser.flow.start") active.add(sessionId);
    if (details.upstreamTool === "browser.flow.finish") active.delete(sessionId);
  }
  return active;
}

function broDetailsFromBranchEntry(entry: unknown): BroToolDetails | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  if (entry.message.role !== "toolResult" || entry.message.isError === true) return undefined;
  if (!isRecord(entry.message.details) || entry.message.details.adapter !== "bro") return undefined;
  return entry.message.details as unknown as BroToolDetails;
}

function sessionDescriptor(ctx: PiExtensionContext): BroSessionDescriptor {
  const id = ctx.sessionManager.getSessionId?.();
  return {
    ...(typeof id === "string" && id.length > 0 ? { id } : {}),
    name: displaySessionName(ctx.sessionManager.getSessionName?.(), id),
  };
}

function displaySessionName(name: string | undefined, id: string | undefined): string {
  return name?.trim() || (id ? `Pi Session ${id.slice(0, 8)}` : "Pi Session");
}

function requireRuntime(runtime: RuntimeState | undefined): RuntimeState {
  if (!runtime) throw new Error("bro Pi extension session has not started");
  return runtime;
}

function asArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export type { BroToolClient } from "./client.ts";
