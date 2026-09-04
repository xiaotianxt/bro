import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  formatByteSize,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINES,
  truncateTextHead,
} from "./text.ts";

const ERROR_MAX_BYTES = 4_096;
const ERROR_MAX_LINES = 100;
const MAX_IMAGES = 4;

export const DEFAULT_ACTIVE_UPSTREAM_TOOLS = new Set([
  "browser.extract",
  "browser.current.extract",
  "browser.batch.extract",
  "browser.batch.flow",
  "browser.network.capture",
  "browser.flow.start",
  "browser.flow.observe",
  "browser.flow.act",
  "browser.flow.finish",
]);

const PI_SESSION_TOOLS = new Set([
  "tabs_context",
  "tabs_create",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "session_name",
  "tabs_claim",
  "tabs_finalize",
]);

export interface BroSessionDescriptor {
  id?: string;
  name?: string;
}

export interface BroCatalogTool {
  upstream: Tool;
  piName: string;
  searchText: string;
  capability?: string;
}

export interface BroToolDetails {
  adapter: "bro";
  upstreamTool: string;
  structuredContent?: unknown;
  truncated: boolean;
  omittedImages: number;
}

export function normalizeBroToolName(upstreamName: string): string {
  const normalized = upstreamName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    throw new Error(`Cannot normalize empty bro tool name: ${JSON.stringify(upstreamName)}`);
  }
  return `bro_${normalized}`;
}

export function buildBroCatalog(
  tools: Tool[],
  existingPiToolNames: Iterable<string>,
): BroCatalogTool[] {
  const existing = new Set(existingPiToolNames);
  const byPiName = new Map<string, string>();
  const catalog = tools
    .filter((tool) => toolPiVisibility(tool) !== "internal")
    .map((upstream) => {
    const piName = normalizeBroToolName(upstream.name);
    const previous = byPiName.get(piName);
    if (previous) {
      throw new Error(
        `bro tool name collision: ${JSON.stringify(previous)} and ${JSON.stringify(upstream.name)} both map to ${piName}`,
      );
    }
    if (existing.has(piName)) {
      throw new Error(`Pi tool name already registered: ${piName}`);
    }
    byPiName.set(piName, upstream.name);

    const propertyNames = isRecord(upstream.inputSchema.properties)
      ? Object.keys(upstream.inputSchema.properties)
      : [];
    const capability = toolCapability(upstream);
    return {
      upstream,
      piName,
      ...(capability ? { capability } : {}),
      searchText: [
        upstream.name,
        piName,
        upstream.description ?? "",
        capability ?? "",
        ...propertyNames,
      ]
        .join(" ")
        .toLowerCase(),
      };
    });

  return catalog;
}

const CAPABILITY_ALIASES: Record<string, string[]> = {
  interaction: ["interact", "interaction", "multi-step", "click", "wait for", "page action", "form workflow"],
  tabs: ["existing tab", "browser tab", "claim tab", "tabs"],
  accessibility: ["accessibility", "refid", "element reference", "shadow dom", "shadow"],
  frames: ["iframe", "child frame", "frame"],
  console: ["console", "page error", "javascript error", "logs"],
  network: ["network", "request body", "response body", "http request"],
  visual: ["visual", "canvas", "screenshot", "coordinate", "drag"],
  upload: ["upload", "file input"],
  userscripts: ["user script", "userscript", "persistent script", "persistent automation"],
  shortcuts: ["shortcut", "keyboard command"],
  advanced: ["raw javascript", "resize window", "advanced browser"],
};

export function searchBroCatalog(
  catalog: BroCatalogTool[],
  query: string,
  limit: number,
): BroCatalogTool[] {
  const normalizedQuery = query.toLowerCase();
  const requestedCapabilities = new Set(
    Object.entries(CAPABILITY_ALIASES)
      .filter(([, aliases]) => aliases.some((alias) => normalizedQuery.includes(alias)))
      .map(([capability]) => capability),
  );
  const packed = catalog.filter(
    (tool) => tool.capability && requestedCapabilities.has(tool.capability),
  );
  const packedNames = new Set(packed.map((tool) => tool.piName));
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (terms.length === 0) return [];

  const lexical = catalog
    .map((tool, index) => {
      const name = `${tool.upstream.name} ${tool.piName}`.toLowerCase();
      const score = terms.reduce((total, term) => {
        if (name === term) return total + 8;
        if (name.includes(term)) return total + 4;
        if (tool.searchText.includes(term)) return total + 1;
        return total;
      }, 0);
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.tool)
    .filter((tool) => !packedNames.has(tool.piName));

  return [...packed, ...lexical].slice(0, limit);
}

function toolCapability(tool: Tool): string | undefined {
  const meta = tool._meta;
  if (!isRecord(meta)) return undefined;
  const capability = meta["bro/capability"];
  return typeof capability === "string" && capability.length > 0 ? capability : undefined;
}

function toolPiVisibility(tool: Tool): string | undefined {
  const meta = tool._meta;
  if (!isRecord(meta)) return undefined;
  const visibility = meta["bro/piVisibility"];
  return typeof visibility === "string" && visibility.length > 0 ? visibility : undefined;
}

export function prepareBroArguments(
  upstreamName: string,
  args: unknown,
  session: BroSessionDescriptor,
): unknown {
  if (!isRecord(args) || !PI_SESSION_TOOLS.has(upstreamName)) return args;

  const prepared: Record<string, unknown> = { ...args };
  if (prepared.sessionId === undefined && session.id) {
    prepared.sessionId = session.id;
  }
  if (upstreamName === "session_name" && prepared.name === undefined && session.name) {
    prepared.name = session.name;
  }
  return prepared;
}

export function throwIfMcpToolFailed(upstreamName: string, result: CallToolResult): void {
  if (result.isError !== true) return;

  const text = textFromMcpContent(result.content);
  const fallback = stringifyJson(result.structuredContent) || "MCP tool returned an error";
  const truncation = truncateTextHead(text || fallback, {
    maxBytes: ERROR_MAX_BYTES,
    maxLines: ERROR_MAX_LINES,
  });
  throw new Error(`${upstreamName}: ${truncation.content}`);
}

export function mapMcpToolResult(
  upstreamName: string,
  result: CallToolResult,
): {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: BroToolDetails;
} {
  const text = textFromMcpContent(result.content) || stringifyJson(result.structuredContent);
  const truncation = truncateTextHead(text || "bro tool completed without text output", {
    maxBytes: MAX_TOOL_OUTPUT_BYTES - 256,
    maxLines: MAX_TOOL_OUTPUT_LINES - 2,
  });
  let boundedText = truncation.content;
  if (truncation.truncated) {
    boundedText +=
      `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines ` +
      `(${formatByteSize(truncation.outputBytes)} of ${formatByteSize(truncation.totalBytes)}).]`;
  }

  const images = imagesFromMcpContent(result.content);
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: boundedText }];
  content.push(...images.slice(0, MAX_IMAGES));

  const structuredContent = boundStructuredContent(result.structuredContent);
  return {
    content,
    details: {
      adapter: "bro",
      upstreamTool: upstreamName,
      ...(structuredContent === undefined ? {} : { structuredContent }),
      truncated: truncation.truncated,
      omittedImages: Math.max(0, images.length - MAX_IMAGES),
    },
  };
}

function textFromMcpContent(content: CallToolResult["content"]): string {
  return content
    .filter((item): item is Extract<(typeof content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

function imagesFromMcpContent(content: CallToolResult["content"]): Array<{
  type: "image";
  data: string;
  mimeType: string;
}> {
  return content
    .filter((item): item is Extract<(typeof content)[number], { type: "image" }> => item.type === "image")
    .map((item) => ({ type: "image" as const, data: item.data, mimeType: item.mimeType }));
}

function boundStructuredContent(value: unknown): unknown {
  if (value === undefined) return undefined;
  const serialized = stringifyJson(value);
  const truncation = truncateTextHead(serialized, {
    maxBytes: MAX_TOOL_OUTPUT_BYTES,
    maxLines: MAX_TOOL_OUTPUT_LINES,
  });
  if (!truncation.truncated) return value;

  return {
    truncated: true,
    preview: truncation.content,
    outputBytes: truncation.outputBytes,
    totalBytes: truncation.totalBytes,
    outputLines: truncation.outputLines,
    totalLines: truncation.totalLines,
  };
}

function stringifyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
