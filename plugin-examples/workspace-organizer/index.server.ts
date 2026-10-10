import type { PluginServerContext } from "@getpaseo/plugin/server";
import { organization } from "./shared/organization";
import { mcpIntegration } from "./shared/mcp-integration";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(organization);
  const integration = server.registerSettings(mcpIntegration);
  server.before("agent.create", async ({ request }) => {
    const settings = await integration.read();
    if (settings.status !== "ready") throw new Error(settings.error);
    if (
      !settings.values.enabled ||
      !settings.values.server ||
      request.config.mcpServers?.["paseo-organizer"]
    )
      return request;
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          "paseo-organizer": settings.values.server,
        },
      },
    };
  });
  return () => {};
}
