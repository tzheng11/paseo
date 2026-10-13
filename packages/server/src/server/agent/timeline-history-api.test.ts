import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import pino from "pino";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { CodexAppServerAgentSession } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import type { AgentClient } from "./agent-sdk-types.js";

test("serves bounded head/tail and lazy middle pages without consuming a full history response", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-history-api-"));
  const app = createFakeCodexAppServer({
    "thread/read": () => ({
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn",
            items: Array.from({ length: 1000 }, (_, index) => ({
              type: index === 500 ? "userMessage" : "agentMessage",
              id: String(index),
              text: `Item ${index}`,
              ...(index === 500 ? { content: [{ type: "text", text: "Middle prompt" }] } : {}),
              timestamp: "2026-10-12T00:00:00.000Z",
            })),
          },
        ],
      },
    }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd },
    { sessionId: "thread-1" },
    pino({ level: "silent" }),
    async () => app.child,
  );
  await session.connect();
  const provider: AgentClient = {
    provider: "codex",
    capabilities: session.capabilities,
    isAvailable: async () => true,
    createSession: async () => session,
    resumeSession: async () => session,
    fetchCatalog: async () => ({ models: [], modes: [] }),
  };
  const ctx = await createDaemonTestContext({
    pluginsEnabled: false,
    relayEnabled: false,
    agentClients: { codex: provider },
  });
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    await ctx.daemon.daemon.agentManager.hydrateTimelineFromProvider(agent.id, { force: true });
    const windows = await ctx.client.fetchAgentTimelineHistory({
      agentId: agent.id,
      operation: "windows",
    });
    expect(windows.head).toHaveLength(64);
    expect(windows.tail).toHaveLength(256);
    expect(windows.gap).toMatchObject({ startIndex: 64, endIndex: 743, count: 680 });
    expect(windows.totalEvents).toBe(1000);
    const timeline = await ctx.client.fetchAgentTimeline(agent.id, { limit: 0 });
    expect(timeline.entries).toHaveLength(321);
    expect(timeline.historyWindow?.gap?.count).toBe(680);
    const page = await ctx.client.fetchAgentTimelineHistory({
      agentId: agent.id,
      operation: "page",
      epoch: windows.epoch,
      cursor: 64,
      limit: { events: 2, bytes: 2048 },
    });
    expect(page.entries?.map((entry) => entry.index)).toEqual([64, 65]);
    expect(page.coveredCount).toBe(2);
    expect(page.nextCursor).toBe(66);
    const matches = await ctx.client.searchAgentTimeline({
      agentId: agent.id,
      query: "Middle prompt",
      includeProviderHistory: true,
    });
    expect(matches.locations).toEqual([
      { seq: 501, historyIndex: 500, messageId: "500", role: "user", count: 1 },
    ]);
    const prompts = await ctx.client.listAgentTimelinePrompts(agent.id, {
      includeProviderHistory: true,
    });
    expect(prompts.prompts).toEqual([
      {
        seq: 501,
        historyIndex: 500,
        messageId: "500",
        timestamp: "2026-10-12T00:00:00.000Z",
        preview: "Middle prompt",
      },
    ]);
    await expect(
      ctx.client.fetchAgentTimelineHistory({
        agentId: agent.id,
        operation: "page",
        epoch: "stale",
        cursor: 64,
      }),
    ).rejects.toThrow("History epoch changed");
    app.assertNoErrors();
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});
