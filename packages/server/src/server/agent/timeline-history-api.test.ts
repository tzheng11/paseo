import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import pino from "pino";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { CodexAppServerAgentSession } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import type { AgentClient, AgentTimelineItem } from "./agent-sdk-types.js";
import { DiskAgentTimelineStore } from "./disk-agent-timeline-store.js";
import type { ProjectedTimelineRow } from "./timeline-projection.js";
import { streamTimelinePromptIndex } from "./timeline-prompt-index.js";

test("cached prompt outlines read only user payloads and retain projected prompt positions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-cached-prompts-api-"));
  const ctx = await createDaemonTestContext({ pluginsEnabled: false, relayEnabled: false });
  const payloads = vi.spyOn(
    DiskAgentTimelineStore.prototype as unknown as {
      readRow(state: unknown, pos: number): ProjectedTimelineRow;
    },
    "readRow",
  );
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    const manager = ctx.daemon.daemon.agentManager;
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: "  First\n prompt 🧪 ",
      clientMessageId: "first",
    });
    for (let index = 0; index < 100; index++) {
      await manager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: `tool-${index}`,
        status: "completed",
        name: "shell",
        error: null,
        detail: { type: "plain_text", text: "x".repeat(32768) },
      });
    }
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: "Second",
      clientMessageId: "second",
    });
    await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "not a prompt" });
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: "  First\n prompt 🧪 ",
      clientMessageId: "first",
    });
    const expected = await streamTimelinePromptIndex(
      manager.getTimelineEpoch(agent.id),
      manager.streamTimelineRows(agent.id),
    );
    payloads.mockClear();
    expect(
      await ctx.client.listAgentTimelinePrompts(agent.id, { requestId: "cached-prompts" }),
    ).toEqual({
      requestId: "cached-prompts",
      agentId: agent.id,
      ...expected,
      error: null,
    });
    expect(payloads.mock.calls.map(([, pos]) => pos)).toEqual([0, 101, 103]);
    expect(payloads.mock.results.map((result) => result.value.item.type)).toEqual([
      "user_message",
      "user_message",
      "user_message",
    ]);
  } finally {
    payloads.mockRestore();
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a cold bounded history RPC refuses full replay without publishing a new writer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-history-cold-api-"));
  const app = createFakeCodexAppServer({
    initialize: () => ({ userAgent: "paseo/0.159.2" }),
    "thread/read": () => ({ thread: { historyMode: "legacy", turns: [] } }),
  });
  const killed = vi.spyOn(app.child, "kill");
  const makeSession = (purpose?: "interactive" | "history" | "maintenance", mode?: "bounded") =>
    new CodexAppServerAgentSession(
      { provider: "codex", cwd, model: "gpt-5.4" },
      { sessionId: "cold-native-thread" },
      pino({ level: "silent" }),
      async () => app.child,
      {},
      false,
      false,
      false,
      undefined,
      purpose,
      mode,
    );
  const provider: AgentClient = {
    provider: "codex",
    capabilities: makeSession().capabilities,
    isAvailable: async () => true,
    createSession: async () => {
      throw new Error("A history read must not create a provider session");
    },
    resumeSession: async (_handle, _overrides, _context, options) => {
      const session = makeSession(options?.purpose, options?.historyReadMode);
      await session.connect();
      return session;
    },
    fetchCatalog: async () => ({ models: [], modes: [] }),
  };
  const ctx = await createDaemonTestContext({
    pluginsEnabled: false,
    relayEnabled: false,
    agentClients: { codex: provider },
  });
  const id = "00000000-0000-4000-8000-000000000701";
  try {
    const storage = ctx.daemon.daemon.agentStorage;
    await storage.upsert({
      id,
      provider: "codex",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastStatus: "closed",
      labels: {},
      config: { model: "gpt-5.4" },
      persistence: {
        provider: "codex",
        sessionId: "cold-native-thread",
        metadata: { provider: "codex", cwd },
      },
    });
    const before = await storage.get(id);
    await expect(
      ctx.client.fetchAgentTimelineHistory({ agentId: id, operation: "windows" }),
    ).rejects.toThrow("Codex cannot read bounded native history for this thread");
    expect(ctx.daemon.daemon.agentManager.getAgent(id)).toBeNull();
    expect(await storage.get(id)).toEqual(before);
    expect(
      app.requests().filter((request) => String(request.method).startsWith("thread/")),
    ).toEqual([
      expect.objectContaining({
        method: "thread/read",
        params: { threadId: "cold-native-thread", includeTurns: false },
      }),
    ]);
    expect(killed).toHaveBeenCalledTimes(1);
    app.assertNoErrors();
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serves complete expanded projection pages and health requests on an isolated daemon", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-history-page-"));
  const ctx = await createDaemonTestContext({ pluginsEnabled: false, relayEnabled: false });
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    const manager = ctx.daemon.daemon.agentManager;
    const tool = (status: "running" | "completed"): AgentTimelineItem => ({
      type: "tool_call",
      callId: "old",
      status,
      name: "shell",
      error: null,
      detail: { type: "plain_text", label: "work" },
    });
    await manager.appendTimelineItem(agent.id, tool("running"));
    for (let index = 0; index < 300; index++)
      await manager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: `${index}:${"x".repeat(8192)}`,
      });
    await manager.appendTimelineItem(agent.id, tool("completed"));
    const [page, health] = await Promise.all([
      ctx.client.fetchAgentTimeline(agent.id, { limit: 1 }),
      fetch(`http://127.0.0.1:${ctx.daemon.port}/api/health`).then((response) => response.json()),
    ]);
    expect(page.entries).toHaveLength(301);
    expect(page.startCursor?.seq).toBe(1);
    expect(page.endCursor?.seq).toBe(302);
    expect(health.status).toBe("ok");
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

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
    const context = await ctx.client.buildAgentForkContext(agent.id, { boundaryMessageId: "501" });
    expect(
      context.attachment?.type === "text" && context.attachment.text.includes("Item 400"),
    ).toBe(true);
    expect(
      context.attachment?.type === "text" && context.attachment.text.includes("Item 502"),
    ).toBe(false);
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
