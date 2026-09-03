import type { Static, TSchema } from "typebox";

export type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiToolResult {
  content: PiToolContent[];
  details?: unknown;
}

export interface PiUi {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface PiSessionManager {
  getSessionId?(): string | undefined;
  getSessionName?(): string | undefined;
  getBranch(): unknown[];
}

export interface PiExtensionContext {
  ui: PiUi;
  sessionManager: PiSessionManager;
}

export interface PiToolDefinition<TParameters extends TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParameters;
  prepareArguments?(args: unknown): unknown;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: PiToolResult) => void) | undefined,
    ctx: PiExtensionContext,
  ): Promise<PiToolResult>;
}

export interface PiExtensionApi {
  registerTool<TParameters extends TSchema>(definition: PiToolDefinition<TParameters>): void;
  getAllTools(): Array<{ name: string }>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(
    event: "session_start",
    handler: (event: { reason: string }, ctx: PiExtensionContext) => Promise<void> | void,
  ): void;
  on(
    event: "session_info_changed",
    handler: (
      event: { name: string | undefined },
      ctx: PiExtensionContext,
    ) => Promise<void> | void,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: { reason: string }, ctx: PiExtensionContext) => Promise<void> | void,
  ): void;
}
