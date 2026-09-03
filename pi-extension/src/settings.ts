import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BRO_MCP_URL = new URL("http://127.0.0.1:3500/mcp");

export function defaultBroSettingsPath(): string {
  return join(homedir(), ".bro", "settings.json");
}

export async function readBroToken(path = defaultBroSettingsPath()): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read bro settings at ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Bro settings at ${path} are malformed`, { cause: error });
  }

  if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token.trim().length === 0) {
    throw new Error(`Bro settings at ${path} do not contain a non-empty token`);
  }

  return parsed.token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
