import { describe, expect, it } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";

describe("organizer MCP injection", () => {
  it("defaults off and preserves a user's existing server when enabled", async () => {
    let handler: Parameters<PluginServerContext["before"]>[1] | undefined;
    const values = {
      enabled: false,
      server: {
        type: "stdio" as const,
        command: "node",
        args: ["mcp.mjs"],
        env: { PASEO_ORGANIZER_HOST: "Studio" },
      },
    };
    const context = {
      registerSettings: () => ({ read: async () => ({ status: "ready", values }) }),
      before: (_name: string, callback: typeof handler) => {
        handler = callback;
      },
    } as unknown as PluginServerContext;
    contribute(context);
    const execute = handler as unknown as (input: {
      request: { config: { mcpServers: Record<string, unknown> } };
    }) => Promise<{ config: { mcpServers: Record<string, unknown> } }>;
    const request = {
      config: { mcpServers: { existing: { type: "http", url: "https://example.com" } } },
    };
    expect(await execute({ request })).toBe(request);
    values.enabled = true;
    expect((await execute({ request })).config.mcpServers).toEqual({
      ...request.config.mcpServers,
      "paseo-organizer": values.server,
    });
    const owned = {
      config: { mcpServers: { "paseo-organizer": { type: "stdio", command: "custom" } } },
    };
    expect(await execute({ request: owned })).toBe(owned);
  });
});
