import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test.each([false, true])(
  "bounded cold loading preserves its policy and durable residency (archived: %s)",
  async (archived) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-bounded-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const clients = createTestAgentClients();
    const client = clients.codex!;
    client.capabilities.supportsBoundedHistory = true;
    const resume = vi.spyOn(client, "resumeSession");
    const manager = new AgentManager({ clients, registry: storage, logger });
    const id = "00000000-0000-4000-8000-000000000601";
    try {
      await manager.createAgent({ provider: "codex", cwd: root }, id, {
        workspaceId: "workspace-bounded",
      });
      if (archived) await manager.archiveAgent(id);
      await manager.closeAgent(id);
      await manager.flush();
      await storage.flush();
      const before = await storage.get(id);
      const loaded = await ensureAgentLoaded(id, {
        agentManager: manager,
        agentStorage: storage,
        logger,
        historyReadMode: "bounded",
      });
      await manager.flush();
      await storage.flush();
      const after = await storage.get(id);
      expect(resume.mock.calls.map((call) => call[3])).toEqual([
        { purpose: archived ? "history" : "interactive", historyReadMode: "bounded" },
      ]);
      expect(loaded.id).toBe(id);
      expect(after?.archivedAt).toBe(before?.archivedAt);
      expect(after?.workspaceId).toBe("workspace-bounded");
      expect(after?.lastUserMessageAt).toBe(before?.lastUserMessageAt);
      expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
    } finally {
      await manager.closeAgent(id);
      await manager.flush();
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("bounded cold loading without a provider handle never creates a first session or changes activity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-bounded-no-handle-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const clients = createTestAgentClients();
  const create = vi.spyOn(clients.codex!, "createSession");
  const manager = new AgentManager({ clients, registry: storage, logger });
  const id = "00000000-0000-4000-8000-000000000602";
  try {
    await manager.createAgent({ provider: "codex", cwd: root }, id, {
      workspaceId: "workspace-no-handle",
    });
    await manager.closeAgent(id);
    await manager.flush();
    const before = (await storage.get(id))!;
    await storage.upsert({ ...before, persistence: null });
    const stored = await storage.get(id);
    await expect(
      ensureAgentLoaded(id, {
        agentManager: manager,
        agentStorage: storage,
        logger,
        historyReadMode: "bounded",
      }),
    ).rejects.toThrow("Bounded history requires an existing provider session");
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.getAgent(id)).toBeNull();
    expect(await storage.get(id)).toEqual(stored);
    await ensureAgentLoaded(id, { agentManager: manager, agentStorage: storage, logger });
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    await manager.closeAgent(id);
    await manager.flush();
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded cold loading refuses an in-flight compatible initialization without joining its replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-bounded-inflight-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const clients = createTestAgentClients();
  const client = clients.codex!;
  const original = client.resumeSession.bind(client);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = vi.spyOn(client, "resumeSession").mockImplementation(async (...args) => {
    entered();
    await blocked;
    return original(...args);
  });
  const manager = new AgentManager({ clients, registry: storage, logger });
  const id = "00000000-0000-4000-8000-000000000603";
  let loading: ReturnType<typeof ensureAgentLoaded> | undefined;
  try {
    await manager.createAgent({ provider: "codex", cwd: root }, id, {
      workspaceId: "workspace-inflight",
    });
    await manager.closeAgent(id);
    const deps = { agentManager: manager, agentStorage: storage, logger };
    loading = ensureAgentLoaded(id, deps);
    await started;
    await expect(ensureAgentLoaded(id, { ...deps, historyReadMode: "bounded" })).rejects.toThrow(
      "Agent history is already loading through a compatible replay",
    );
    expect(resume).toHaveBeenCalledTimes(1);
    release();
    await loading;
    expect((await ensureAgentLoaded(id, deps)).id).toBe(id);
  } finally {
    release();
    await loading;
    await manager.closeAgent(id);
    await manager.flush();
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary initialization can join a bounded cold load and retain the same usable session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-bounded-joined-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const clients = createTestAgentClients();
  const client = clients.codex!;
  client.capabilities.supportsBoundedHistory = true;
  const original = client.resumeSession.bind(client);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = vi.spyOn(client, "resumeSession").mockImplementation(async (...args) => {
    entered();
    await blocked;
    return original(...args);
  });
  const manager = new AgentManager({ clients, registry: storage, logger });
  const id = "00000000-0000-4000-8000-000000000604";
  let loading: ReturnType<typeof ensureAgentLoaded> | undefined;
  try {
    await manager.createAgent({ provider: "codex", cwd: root }, id, {
      workspaceId: "workspace-joined",
    });
    await manager.closeAgent(id);
    const deps = { agentManager: manager, agentStorage: storage, logger };
    loading = ensureAgentLoaded(id, { ...deps, historyReadMode: "bounded" });
    await started;
    const ordinary = ensureAgentLoaded(id, deps);
    release();
    const [boundedAgent, ordinaryAgent] = await Promise.all([loading, ordinary]);
    expect(ordinaryAgent.id).toBe(boundedAgent.id);
    expect(ordinaryAgent.session).toBe(boundedAgent.session);
    expect(resume.mock.calls.map((call) => call[3])).toEqual([
      { purpose: "interactive", historyReadMode: "bounded" },
    ]);
    await startAgentRun(manager, id, "continue after reading", logger, {});
    expect((await manager.waitForAgentEvent(id)).status).toBe("idle");
    expect(resume).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await loading;
    await manager.closeAgent(id);
    await manager.flush();
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads an archived agent's history after its working directory is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const worktree = path.join(root, "managed-worktree");
  await mkdir(worktree, { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000501";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
      workspaceId: "workspace-worktree",
    });
    await startAgentRun(manager, agent.id, "what did you change", logger, {});
    // Dispatching a run does not finish it: the provider appends the reply to its
    // history afterwards, and the turn is finalized only once that append lands.
    // Archive after the turn is finalized so the transcript this test reads back is
    // already on disk when the worktree goes away.
    const finished = await manager.waitForAgentEvent(agent.id);
    expect(finished.status).toBe("idle");
    await manager.archiveAgent(agent.id);
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    // Archiving the workspace removes the worktree it owned. The agent's history is
    // persisted and reading it must not depend on that directory still being there.
    await rm(worktree, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
