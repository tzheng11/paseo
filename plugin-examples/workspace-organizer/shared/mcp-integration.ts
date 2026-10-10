import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const mcpIntegration = defineSettings({
  id: "mcp-integration",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    server: z
      .object({
        type: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
      })
      .nullable()
      .default(null),
  }),
});
