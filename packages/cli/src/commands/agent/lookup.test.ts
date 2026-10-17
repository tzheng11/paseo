import { describe, expect, test } from "vitest";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentsResponseMessageSchema,
  ProjectPlacementPayloadSchema,
  type AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";
import type {
  DaemonClient,
  FetchAgentOptions,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import { executeAgentReload, parseAgentReloadRequest } from "./reload.js";
import { executeAgentArchive } from "./archive.js";
import { executeAgentDetach } from "./detach.js";
import { executeAgentStop } from "./stop.js";
import { executePermitLs } from "../permit/ls.js";
import { executeWorktreeLs } from "../worktree/ls.js";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

class AgentDirectory {
  agents: AgentSnapshotPayload[] = Array.from({ length: 401 }, (_, i) =>
    AgentSnapshotPayloadSchema.parse({
      id: id(i),
      title: `Actor ${i}`,
      provider: "codex",
      cwd: "/tmp/unrelated",
      model: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      updatedAt: "2026-10-17T00:00:00Z",
      status: "idle",
      archivedAt: null,
      labels: {},
      pendingPermissions: [],
      lastUserMessageAt: null,
      currentModeId: null,
      availableModes: [],
      persistence: null,
      capabilities: {
        supportsStreaming: false,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
    }),
  );
  pages: FetchAgentsOptions[] = [];
  lookups: string[] = [];
  mutations: string[] = [];
  pageFailureAt: number | null = null;
  lookupFailure: Error | null = null;
  lookupOverride: AgentSnapshotPayload | null = null;
  worktrees: Awaited<ReturnType<DaemonClient["getPaseoWorktreeList"]>>["worktrees"] = [];

  async fetchAgents(input?: FetchAgentsOptions | string) {
    const options = typeof input === "string" ? {} : (input ?? {});
    if (options.filter?.includeBackground)
      throw new Error("Host has no backgroundWorkspaces capability");
    this.pages.push(options);
    const start = Number(options.page?.cursor ?? 0);
    if (this.pageFailureAt === start) throw new Error("Later page unavailable");
    const end = start + 200;
    const entries = this.agents.slice(start, end).map((agent) => ({
      agent,
      project: ProjectPlacementPayloadSchema.parse({
        projectKey: "test",
        projectName: "Test",
        checkout: {
          cwd: agent.cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      }),
    }));
    return FetchAgentsResponseMessageSchema.shape.payload.parse({
      requestId: "list",
      entries,
      pageInfo: {
        hasMore: end < this.agents.length,
        nextCursor: end < this.agents.length ? String(end) : null,
        prevCursor: null,
      },
    });
  }
  async fetchAgent(input: FetchAgentOptions | string) {
    const agentId = typeof input === "string" ? input : input.agentId;
    this.lookups.push(agentId);
    if (this.lookupFailure) throw this.lookupFailure;
    const agent = this.lookupOverride ?? this.agents.find((a) => a.id === agentId);
    return agent ? { agent, project: null } : null;
  }
  async refreshAgent(agentId: string) {
    this.mutations.push(agentId);
    return { status: "agent_refreshed" as const, requestId: "reload", agentId, timelineSize: 0 };
  }
  async reloadIdleAgent(input: { agentId: string }) {
    return this.refreshAgent(input.agentId);
  }
  async reloadAgentCredentials(input: { agentId: string; operationId: string }) {
    return { ...input, status: "completed" as const };
  }
  async archiveAgent(agentId: string) {
    this.mutations.push(agentId);
    return { archivedAt: "2026-10-17T18:00:00Z" };
  }
  async detachAgent(agentId: string) {
    this.mutations.push(agentId);
  }
  async cancelAgent(agentId: string) {
    this.mutations.push(agentId);
  }
  async getPaseoWorktreeList() {
    return { worktrees: this.worktrees, error: null, requestId: "worktrees" };
  }
}

const actions = [
  {
    name: "reload",
    run: (client: AgentDirectory, query: string) =>
      executeAgentReload(client, parseAgentReloadRequest(query, {})),
  },
  {
    name: "archive",
    run: (client: AgentDirectory, query: string) => executeAgentArchive(client, query, {}),
  },
  { name: "detach", run: executeAgentDetach },
];

describe.each(actions)("$name agent lookup", ({ run }) => {
  test("uses exact lookup for an older full ID beyond 200 agents", async () => {
    const client = new AgentDirectory();
    await run(client, id(400));
    expect(client.lookups).toEqual([id(400)]);
    expect(client.pages).toEqual([]);
    expect(client.mutations).toEqual([id(400)]);
  });
  test("normalizes an uppercase UUID before exact lookup", async () => {
    const client = new AgentDirectory();
    const canonical = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    client.agents[400]!.id = canonical;
    await run(client, canonical.toUpperCase());
    expect(client.lookups).toEqual([canonical]);
    expect(client.mutations).toEqual([canonical]);
  });
  test("does not require background-workspace support for name resolution", async () => {
    const client = new AgentDirectory();
    await run(client, "Actor 400");
    expect(client.mutations).toEqual([id(400)]);
  });
  test.each(["Actor 400", id(400).slice(0, -1)])(
    "resolves %s after scanning every page",
    async (query) => {
      const client = new AgentDirectory();
      await run(client, query);
      expect(client.mutations).toEqual([id(400)]);
      expect(client.pages.map((input) => input.page?.cursor)).toEqual([undefined, "200", "400"]);
      expect(
        client.pages.every((p) => p.filter?.includeArchived && !p.filter.includeBackground),
      ).toBe(true);
    },
  );
  test.each(["Shared actor", "00000000"])(
    "refuses ambiguous matches across pages: %s",
    async (query) => {
      const client = new AgentDirectory();
      client.agents[0]!.title = query;
      client.agents[400]!.title = query;
      await expect(run(client, query)).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
      expect(client.mutations).toEqual([]);
    },
  );
  test("never resolves a missing full ID as somebody else's title", async () => {
    const client = new AgentDirectory();
    client.agents[0]!.title = id(999);
    client.lookupOverride = client.agents[0]!;
    await expect(run(client, id(999))).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(client.mutations).toEqual([]);
  });
  test("does not hide a direct lookup transport failure", async () => {
    const client = new AgentDirectory();
    client.lookupFailure = new Error("Connection lost");
    await expect(run(client, id(400))).rejects.toThrow("Connection lost");
    expect(client.pages).toEqual([]);
    expect(client.mutations).toEqual([]);
  });
});

test("archive keeps running and already-archived guards on direct lookup", async () => {
  const client = new AgentDirectory();
  client.agents[400]!.status = "running";
  await expect(executeAgentArchive(client, id(400), {})).rejects.toMatchObject({
    code: "AGENT_RUNNING",
  });
  client.agents[400]!.archivedAt = "2026-10-16T00:00:00Z";
  await expect(executeAgentArchive(client, id(400), { force: true })).rejects.toMatchObject({
    code: "AGENT_ALREADY_ARCHIVED",
  });
  expect(client.mutations).toEqual([]);
});

test("stop --all includes running agents past 200 and excludes archived agents", async () => {
  const client = new AgentDirectory();
  for (const agent of client.agents) agent.status = "running";
  client.agents[0]!.archivedAt = "2026-10-16T00:00:00Z";
  const result = await executeAgentStop(client, undefined, { all: true });
  expect(result.data.stoppedCount).toBe(400);
  expect(client.mutations).toEqual(client.agents.slice(1).map((a) => a.id));
});

test("stop --cwd finds only running descendants on later pages", async () => {
  const client = new AgentDirectory();
  client.agents[400]!.cwd = "/tmp/project/child";
  client.agents[400]!.status = "running";
  client.agents[399]!.cwd = "/tmp/project-sibling";
  client.agents[399]!.status = "running";
  const result = await executeAgentStop(client, undefined, { cwd: "/tmp/project" });
  expect(result.data.agentIds).toEqual([id(400)]);
});

test("stop of one ID does not enumerate the inventory", async () => {
  const client = new AgentDirectory();
  client.agents[400]!.status = "running";
  await executeAgentStop(client, id(400), {});
  expect(client.pages).toEqual([]);
  expect(client.mutations).toEqual([id(400)]);
});

test("a failed later page prevents any bulk stop", async () => {
  const client = new AgentDirectory();
  client.pageFailureAt = 200;
  for (const agent of client.agents) agent.status = "running";
  await expect(executeAgentStop(client, undefined, { all: true })).rejects.toThrow(
    "Later page unavailable",
  );
  expect(client.mutations).toEqual([]);
});

test("permit ls includes pending permissions on older agents", async () => {
  const client = new AgentDirectory();
  client.agents[400]!.pendingPermissions = [
    {
      id: "permission",
      name: "Shell",
      provider: "codex",
      kind: "tool",
      description: "Run a command",
      input: {},
    },
  ];
  const result = await executePermitLs(client);
  expect(result.data.map((r) => [r.id, r.agentId])).toEqual([["permission", id(400)]]);
});

test("worktree ls associates an older agent with its worktree", async () => {
  const client = new AgentDirectory();
  client.agents[400]!.cwd = "/tmp/worktree";
  client.worktrees = [
    { worktreePath: "/tmp/worktree", branchName: "fix/example", createdAt: "2026-10-17T00:00:00Z" },
  ];
  const result = await executeWorktreeLs(client, "/tmp");
  expect(result.data[0]).toMatchObject({ cwd: "/tmp/worktree", agent: id(400).slice(0, 7) });
  expect(client.pages).toHaveLength(3);
});
