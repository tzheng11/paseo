import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { SDKMessage, SlashCommand, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { TreeKillTarget, TerminateWithTreeKillResult } from "../../../../utils/tree-kill.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { ReloadOperationStore } from "../../reload-operation-store.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQuery, ClaudeQueryInput } from "./query.js";
import { claudeProjectDirSync } from "./project-dir.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface QueuedSdkMessage {
  message: SDKMessage;
  processed: () => void;
}

class InMemoryClaudeQuery implements ClaudeQuery {
  commands: Promise<SlashCommand[]> = Promise.resolve([]);
  commandRequests = 0;
  closeCalls = 0;
  interrupts = 0;
  onDelivered: (() => void) | null = null;
  private readonly messages: QueuedSdkMessage[] = [];
  private wake: (() => void) | null = null;
  private processed: (() => void) | null = null;
  private stopped = false;
  async next(): Promise<IteratorResult<SDKMessage, void>> {
    this.processed?.();
    this.processed = null;
    while (!this.stopped && this.messages.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    if (this.stopped) return { done: true, value: undefined };
    const queued = this.messages.shift();
    if (!queued) throw new Error("Expected queued SDK message");
    this.processed = queued.processed;
    this.onDelivered?.();
    return { done: false, value: queued.message };
  }
  emit(message: SDKMessage): Promise<void> {
    const processed = deferred<void>();
    this.messages.push({ message, processed: () => processed.resolve() });
    this.wake?.();
    return processed.promise;
  }
  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.stopped = true;
    this.wake?.();
    return { done: true, value: undefined };
  }
  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    throw error;
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async interrupt(): Promise<undefined> {
    this.interrupts += 1;
    return undefined;
  }
  close() {
    this.closeCalls += 1;
    this.stopped = true;
    this.wake?.();
  }
  async setPermissionMode() {}
  async setModel() {}
  async applyFlagSettings() {}
  async supportedCommands() {
    this.commandRequests += 1;
    return this.commands;
  }
  async supportedModels() {
    return [];
  }
  async rewindFiles() {
    return { canRewind: true };
  }
}

class InMemoryClaudeChild extends ChildProcess {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

const sessionId = "80c16252-cab4-4e1d-872a-a2c27fc34817";

interface HarnessOptions {
  resolveBinary?: () => Promise<string>;
  spawnChild?: boolean;
  onTerminate?: () => void;
}

describe("Claude credential maintenance", () => {
  let root: string;
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "claude-maintenance-"));
    cwd = path.join(root, "repo");
    configDir = path.join(root, "claude");
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  function harness(options: HarnessOptions = {}) {
    const query = new InMemoryClaudeQuery();
    const child = new InMemoryClaudeChild();
    const queries = [query];
    const children = [child];
    const launches: ClaudeQueryInput[] = [];
    const prompts: unknown[] = [];
    const terminations: TreeKillTarget[] = [];
    let spawnCalls = 0;
    let cleanupResult: TerminateWithTreeKillResult = "terminated";
    let cleanupPromise: Promise<TerminateWithTreeKillResult> | null = null;
    const forks: string[] = [];
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
      resolveBinary: options.resolveBinary ?? (async () => "/fake/claude"),
      queryFactory(input) {
        launches.push(input);
        const prompt = input.prompt;
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        void (async () => {
          for await (const message of prompt) prompts.push(message);
        })();
        if (options.spawnChild !== false) {
          input.options.spawnClaudeCodeProcess?.(spawnOptions(input));
        }
        if (launches.length === 1) return query;
        const fresh = new InMemoryClaudeQuery();
        queries.push(fresh);
        return fresh;
      },
      spawnProcess() {
        spawnCalls += 1;
        if (spawnCalls === 1) return child;
        const fresh = new InMemoryClaudeChild();
        children.push(fresh);
        return fresh;
      },
      rewindSdk: {
        async forkSession(_sessionId, forkOptions) {
          forks.push(forkOptions.upToMessageId);
          return { sessionId: "forked-session" };
        },
      },
      async terminateProcess(target) {
        terminations.push(target);
        options.onTerminate?.();
        if (cleanupPromise) return cleanupPromise;
        if (cleanupResult !== "kill-timeout") {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }
        return cleanupResult;
      },
    });
    function spawnOptions(input: ClaudeQueryInput): SpawnOptions {
      return {
        command: "/fake/claude",
        args: [],
        cwd,
        env: {},
        signal: input.options.abortController?.signal ?? new AbortController().signal,
      };
    }
    return {
      client,
      query,
      child,
      launches,
      prompts,
      terminations,
      forks,
      queries,
      children,
      spawnOptions,
      get spawnCalls() {
        return spawnCalls;
      },
      set cleanupResult(value: TerminateWithTreeKillResult) {
        cleanupResult = value;
      },
      set cleanupPromise(value: Promise<TerminateWithTreeKillResult>) {
        cleanupPromise = value;
      },
      resume: () =>
        client.resumeSession({ provider: "claude", sessionId }, { cwd }, undefined, {
          purpose: "maintenance",
        }),
    };
  }

  function writeTranscript(text: string): void {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "history-user",
        sessionId,
        timestamp: "2026-10-17T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n",
    );
  }

  test("warms a fresh control-ready query without sending a model prompt", async () => {
    const h = harness();
    const session = await h.resume();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.options.resume).toBe(sessionId);
    expect(h.query.commandRequests).toBe(1);
    expect(h.query.interrupts).toBe(0);
    expect(h.spawnCalls).toBe(1);
    expect(session.hasActiveBackgroundTasks?.()).toBe(false);
    await session.close();
    expect(h.prompts).toEqual([]);
  });

  test("background membership survives query reuse and resets only for a new owned child", async () => {
    const h = harness();
    const session = await h.resume();
    await h.query.emit({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "snapshot",
      session_id: sessionId,
      tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "shell" }],
    });
    expect(session.hasActiveBackgroundTasks?.()).toBe(true);
    await session.listCommands?.();
    expect(session.hasActiveBackgroundTasks?.()).toBe(true);
    expect(h.spawnCalls).toBe(1);
    await h.query.emit({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "snapshot-empty",
      session_id: sessionId,
      tasks: [],
    });
    expect(session.hasActiveBackgroundTasks?.()).toBe(false);
    await h.query.emit({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "snapshot-again",
      session_id: sessionId,
      tasks: [{ task_id: "bash-2", task_type: "local_bash", description: "another shell" }],
    });
    expect(session.hasActiveBackgroundTasks?.()).toBe(true);
    await session.setThinkingOption?.("high");
    await session.listCommands?.();
    expect(h.spawnCalls).toBe(2);
    expect(h.children[0]).not.toBe(h.children[1]);
    expect(session.hasActiveBackgroundTasks?.()).toBe(false);
    await session.close();
  });

  test("defers transcript replay until real history is explicitly requested", async () => {
    writeTranscript("BEFORE MAINTENANCE");
    const h = harness();
    const session = await h.resume();
    writeTranscript("AFTER MAINTENANCE");
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "claude",
      timestamp: "2026-10-17T10:00:00.000Z",
      item: { type: "user_message", text: "AFTER MAINTENANCE", messageId: "history-user" },
    });
    expect(JSON.stringify(events)).not.toContain("BEFORE MAINTENANCE");
    await session.close();
  });

  test("closing during deferred large-history replay cancels it without blocking callbacks", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      Array.from({ length: 1024 }, (_, index) =>
        JSON.stringify({
          type: "user",
          uuid: `user-${index}`,
          message: { role: "user", content: `message ${index}` },
          metadata: "x".repeat(8192),
        }),
      ).join("\n"),
    );
    const h = harness();
    const session = await h.resume();
    const history = session.streamHistory();
    const heartbeat = new Promise<"heartbeat">((resolve) =>
      setImmediate(() => resolve("heartbeat")),
    );
    const first = history.next();
    expect(await Promise.race([heartbeat, first.then(() => "history")])).toBe("heartbeat");
    await session.close();
    expect(await first).toEqual({ done: true, value: undefined });
    expect(h.spawnCalls).toBe(1);
    expect(h.prompts).toEqual([]);
  });

  test("guarded reload owns streamed-history cancellation and late cleanup before queued metadata", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      Array.from({ length: 1024 }, (_, index) =>
        JSON.stringify({
          type: "user",
          uuid: `user-${index}`,
          message: { role: "user", content: `message ${index}` },
          metadata: "x".repeat(8192),
        }),
      ).join("\n"),
    );
    const cleanupStarted = deferred<void>();
    const cleanup = deferred<TerminateWithTreeKillResult>();
    const h = harness({ onTerminate: () => cleanupStarted.resolve() });
    h.cleanupPromise = cleanup.promise;
    const session = await h.resume();
    // Only the SDK/process boundary is substituted. History, manager lifecycle,
    // metadata and durable reload receipts use the real combined implementation.
    vi.spyOn(h.client, "isAvailable").mockResolvedValue(true);
    vi.spyOn(h.client, "createSession").mockResolvedValueOnce(session);
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const manager = new AgentManager({
      clients: { claude: h.client },
      logger,
      registry: storage,
      reloadOperations: new ReloadOperationStore(path.join(root, "operations"), logger, {
        completionTimeoutMs: 10,
      }),
    });
    const agent = await manager.createAgent(
      { provider: "claude", cwd, model: "claude-sonnet-4-5" },
      undefined,
      { workspaceId: undefined },
    );
    const change = {
      credentialGeneration: "original-fixture-generation",
      credentialChangedAt: "2026-10-17T12:00:00.000Z",
    };
    try {
      const first = session.streamHistory().next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        await manager.reloadAgentCredentials(agent.id, "streamed-close", change),
      ).toMatchObject({
        status: "pending",
        ...change,
      });
      await cleanupStarted.promise;
      expect(await first).toEqual({ done: true, value: undefined });
      const title = manager.setTitle(agent.id, "Retained after cleanup");
      await vi.waitFor(async () =>
        expect(await manager.getReloadOperation("streamed-close")).toMatchObject({
          status: "unknown",
          reasonCode: "RELOAD_COMPLETION_UNCONFIRMED",
          retryable: false,
          ...change,
        }),
      );
      // Keep the real provider close unresolved beyond the old production 3s
      // deadline; only the receipt acknowledgement may time out here.
      await new Promise<void>((resolve) => setTimeout(resolve, 3_100));
      expect(
        await manager.reloadAgentCredentials(agent.id, "streamed-close", change),
      ).toMatchObject({
        status: "unknown",
      });
      await expect(manager.runAgent(agent.id, "must stay fenced")).rejects.toMatchObject({
        code: "agent_reload_in_progress",
      });
      expect(h.spawnCalls).toBe(1);
      expect(h.terminations).toHaveLength(1);
      expect(h.prompts).toEqual([]);

      cleanup.resolve("terminated");
      await title;
      await vi.waitFor(async () =>
        expect(await manager.getReloadOperation("streamed-close")).toMatchObject({
          status: "completed",
          agentId: agent.id,
          ...change,
        }),
      );
      expect(h.spawnCalls).toBe(2);
      expect((await storage.get(agent.id))?.title).toBe("Retained after cleanup");
      const writes = vi.spyOn(storage, "applySnapshot");
      await manager.setTitle(agent.id, "Retained after cleanup");
      expect(writes).not.toHaveBeenCalled();
      expect(h.prompts).toEqual([]);
    } finally {
      cleanup.resolve("terminated");
      await manager.closeAgent(agent.id);
    }
  });

  test("a missing resumed conversation cancels in-progress history before the next turn", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      Array.from({ length: 1024 }, (_, index) =>
        JSON.stringify({
          type: "user",
          uuid: `stale-${index}`,
          message: { role: "user", content: "STALE HISTORY" },
          metadata: "x".repeat(8192),
        }),
      ).join("\n"),
    );
    const retiring = deferred<void>();
    const retired = deferred<TerminateWithTreeKillResult>();
    const h = harness({ onTerminate: () => retiring.resolve() });
    const session = await h.resume();
    h.cleanupPromise = retired.promise;
    const history = session.streamHistory();
    const first = history.next();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      void h.query.emit({
        type: "result",
        subtype: "error_during_execution",
        uuid: "missing-resume",
        session_id: sessionId,
        errors: [`No conversation found with session ID: ${sessionId}`],
      });
      await retiring.promise;
      expect(await first).toEqual({ done: true, value: undefined });
      const starting = session.startTurn("new turn");
      const heartbeat = new Promise<"heartbeat">((resolve) =>
        setImmediate(() => resolve("heartbeat")),
      );
      expect(await Promise.race([heartbeat, starting.then(() => "started")])).toBe("heartbeat");
      expect(h.prompts).toEqual([]);
      retired.resolve("terminated");
      await starting;
      expect(await session.streamHistory().next()).toEqual({ done: true, value: undefined });
      expect(h.launches).toHaveLength(2);
    } finally {
      retired.resolve("terminated");
      await session.close();
    }
  });

  test("interrupt during deferred history cannot dispatch the waiting model prompt", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      Array.from({ length: 1024 }, () =>
        JSON.stringify({ type: "progress", metadata: "x".repeat(8192) }),
      ).join("\n"),
    );
    const h = harness();
    const session = await h.resume();
    try {
      const starting = session.startTurn("must not dispatch");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await session.interrupt();
      await expect(starting).rejects.toThrow("interrupted");
      expect(h.prompts).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("live tool results wait for deferred history to rebuild the owning tool call", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    const lines = Array.from({ length: 1024 }, () =>
      JSON.stringify({ type: "progress", metadata: "x".repeat(8192) }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_history",
              name: "Bash",
              input: { command: "echo historical" },
            },
          ],
        },
      }),
    );
    writeFileSync(path.join(directory, `${sessionId}.jsonl`), lines.join("\n"));
    const h = harness();
    const session = await h.resume();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const history = session.streamHistory();
      const first = history.next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const processed = h.query.emit({
        type: "user",
        uuid: "live-result",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_history", content: "LIVE OUTPUT" }],
        },
      });
      await first;
      await processed;
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({
            type: "tool_call",
            callId: "toolu_history",
            name: "Bash",
            status: "completed",
            detail: expect.objectContaining({
              type: "shell",
              command: "echo historical",
              output: "LIVE OUTPUT",
            }),
          }),
        }),
      );
      await history.return();
    } finally {
      await session.close();
    }
  });

  test("closing suppresses SDK frames queued behind deferred history replay", async () => {
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      Array.from({ length: 1024 }, () =>
        JSON.stringify({ type: "progress", metadata: "x".repeat(8192) }),
      ).join("\n"),
    );
    const h = harness();
    const session = await h.resume();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.streamHistory().next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const delivered = deferred<void>();
    h.query.onDelivered = () => delivered.resolve();
    void h.query.emit({
      type: "user",
      uuid: "late-user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: "must not arrive after close" },
    });
    await delivered.promise;
    await session.close();
    expect(await first).toEqual({ done: true, value: undefined });
    expect(session.hasActiveBackgroundTasks?.()).toBe(false);
    expect(events).toEqual([]);
  });

  test("explicit rewind loads deferred real anchors before choosing its fork", async () => {
    const h = harness();
    const session = await h.resume();
    const directory = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${sessionId}.jsonl`),
      [
        { type: "user", uuid: "user-1", message: { role: "user", content: "first" } },
        {
          type: "assistant",
          uuid: "assistant-1",
          message: { role: "assistant", content: "reply" },
        },
        { type: "user", uuid: "user-2", message: { role: "user", content: "second" } },
      ]
        .map((entry) => JSON.stringify({ ...entry, sessionId }))
        .join("\n") + "\n",
    );
    await session.revertConversation?.({ messageId: "user-2" });
    expect(h.forks).toEqual(["assistant-1"]);
    await session.close();
  });

  test("ordinary resume keeps eager history and lazy process startup", async () => {
    writeTranscript("ORDINARY HISTORY");
    const h = harness();
    const session = await h.client.resumeSession({ provider: "claude", sessionId }, { cwd });
    writeTranscript("NEW FILE CONTENT");
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    expect(JSON.stringify(events)).toContain("ORDINARY HISTORY");
    expect(JSON.stringify(events)).not.toContain("NEW FILE CONTENT");
    expect(h.launches).toEqual([]);
    await session.close();
  });

  test("never-resolving binary lookup has a bounded uncertain outcome and fences late resolution", async () => {
    vi.useFakeTimers();
    const binary = deferred<string>();
    const h = harness({ resolveBinary: () => binary.promise });
    const resumed = h.resume();
    const rejected = expect(resumed).rejects.toMatchObject({ code: "reload_startup_unconfirmed" });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    binary.resolve("/late/claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.launches).toEqual([]);
    expect(h.spawnCalls).toBe(0);
  });

  test("a timed-out query closes its owned child before startup fails", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.query.commands = new Promise(() => undefined);
    const resumed = h.resume();
    const rejected = expect(resumed).rejects.toThrow("startup exceeded 30000ms");
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(h.terminations).toEqual([h.child]);
    expect(h.query.closeCalls).toBe(1);
    expect(h.prompts).toEqual([]);
  });

  test("a timed-out SDK query cannot spawn a late child", async () => {
    vi.useFakeTimers();
    const h = harness({ spawnChild: false });
    h.query.commands = new Promise(() => undefined);
    const resumed = h.resume();
    const rejected = expect(resumed).rejects.toMatchObject({ code: "reload_startup_unconfirmed" });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    const input = h.launches[0];
    if (!input) throw new Error("Expected captured query launch");
    expect(() => input.options.spawnClaudeCodeProcess?.(h.spawnOptions(input))).toThrow();
    expect(h.spawnCalls).toBe(0);
    expect(h.query.closeCalls).toBe(1);
  });

  test("unconfirmed child exit rejects close and preserves ownership for a cleanup retry", async () => {
    const h = harness();
    const session = await h.resume();
    h.cleanupResult = "kill-timeout";
    await expect(session.close()).rejects.toMatchObject({ code: "reload_cleanup_unconfirmed" });
    h.cleanupResult = "terminated";
    await session.close();
    expect(h.terminations).toEqual([h.child, h.child]);
  });

  test("an unresolved child cleanup is bounded and remains uncertain", async () => {
    vi.useFakeTimers();
    const h = harness();
    const session = await h.resume();
    h.cleanupPromise = new Promise(() => undefined);
    const closed = session.close();
    const rejected = expect(closed).rejects.toMatchObject({ code: "reload_cleanup_unconfirmed" });
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(h.terminations).toEqual([h.child]);
    h.cleanupPromise = Promise.resolve("terminated");
    await session.close();
  });

  test("startup reports uncertainty when its child cleanup cannot be confirmed", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.query.commands = new Promise(() => undefined);
    h.cleanupResult = "kill-timeout";
    const resumed = h.resume();
    const rejected = expect(resumed).rejects.toMatchObject({ code: "reload_cleanup_unconfirmed" });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(h.terminations).toEqual([h.child]);
  });
});
