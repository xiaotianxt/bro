import { describe, expect, it } from "vitest";
import { BroMcpClient } from "../src/client.ts";

const describeLive = process.env.BRO_LIVE_TEST === "1" ? describe : describe.skip;

describeLive("live bro MCP transport", () => {
  it("discovers and calls tools through one official SDK connection", async () => {
    const client = new BroMcpClient();
    try {
      const tools = await client.listTools();
      expect(tools.some((tool) => tool.name === "browser.extract")).toBe(true);
      expect(tools.some((tool) => tool.name === "tabs_finalize")).toBe(true);

      const result = await client.callTool("browsers_context", {});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
    } finally {
      await client.close();
    }
  });
});
