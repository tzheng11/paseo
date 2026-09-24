import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";

test("idle-only reload round-trips through an isolated daemon and leaves archived agents archived", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-idle-reload-rpc-"));
  const ctx = await createDaemonTestContext();
  try {
    expect(ctx.client.getLastServerInfoMessage()?.features?.idleAgentReload).toBe(true);
    const agent = await ctx.client.createAgent({ config: { provider: "codex", cwd } });
    await expect(ctx.client.reloadIdleAgent({ agentId: agent.id })).resolves.toMatchObject({
      status: "agent_refreshed",
      agentId: agent.id,
      timelineSize: 0,
    });
    await ctx.client.archiveAgent(agent.id);
    await expect(ctx.client.reloadIdleAgent({ agentId: agent.id })).rejects.toMatchObject({
      code: "agent_reload_unavailable",
      requestType: "agent.reload_idle.request",
    });
    const archived = await ctx.client.fetchAgent({ agentId: agent.id });
    expect(archived?.agent.archivedAt).toBeTruthy();
    // The legacy operation still supports its existing unarchive behavior.
    await expect(ctx.client.refreshAgent(agent.id)).resolves.toMatchObject({
      status: "agent_refreshed",
      agentId: agent.id,
    });
    const refreshed = await ctx.client.fetchAgent({ agentId: agent.id });
    expect(refreshed?.agent.archivedAt).toBeNull();
  } finally {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
