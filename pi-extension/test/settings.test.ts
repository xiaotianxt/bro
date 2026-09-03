import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBroToken } from "../src/settings.ts";

const temporaryDirectories: string[] = [];

async function temporarySettings(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-bro-settings-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "settings.json");
  await writeFile(path, contents, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readBroToken", () => {
  it("reads a non-empty token", async () => {
    const path = await temporarySettings('{"token":"local-token"}\n');

    await expect(readBroToken(path)).resolves.toBe("local-token");
  });

  it("rejects malformed settings without exposing their contents", async () => {
    const path = await temporarySettings("{ malformed secret material");

    await expect(readBroToken(path)).rejects.toThrow(`Bro settings at ${path} are malformed`);
  });

  it("rejects an empty token", async () => {
    const path = await temporarySettings('{"token":""}\n');

    await expect(readBroToken(path)).rejects.toThrow("do not contain a non-empty token");
  });
});
