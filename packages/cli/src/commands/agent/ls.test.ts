import { Command } from "commander";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../output/index.js";
import { buildAgentLsFetchOptions, runLsCommand, type AgentLsOptions } from "./ls.js";

const { fetchAgents, close } = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ fetchAgents, close })),
}));

function makeAgent(
  index: number,
  overrides: Partial<AgentSnapshotPayload> = {},
): AgentSnapshotPayload {
  return {
    id: `agent-${String(index).padStart(5, "0")}`,
    title: `Agent ${index}`,
    provider: "codex",
    cwd: "/tmp/project",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    status: "idle",
    archivedAt: null,
    labels: {},
    ...overrides,
  } as AgentSnapshotPayload;
}

function page(agents: AgentSnapshotPayload[], nextCursor: string | null = null) {
  return {
    entries: agents.map((agent) => ({ agent })),
    pageInfo: { hasMore: nextCursor !== null, nextCursor, prevCursor: null },
  };
}

beforeEach(() => {
  fetchAgents.mockReset();
  close.mockReset().mockResolvedValue(undefined);
});

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("asks the daemon for internal agents only with --internal", () => {
    expect(buildAgentLsFetchOptions({ background: true, global: true })).toEqual({
      filter: { includeBackground: true },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("includes archived and background agents with -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("runLsCommand pagination", () => {
  it("lists every agent across more than two full pages and preserves JSON output", async () => {
    const agents = Array.from({ length: 401 }, (_, index) => makeAgent(index));
    fetchAgents
      .mockResolvedValueOnce(page(agents.slice(0, 200), "page-2"))
      .mockResolvedValueOnce(page(agents.slice(200, 400), "page-3"))
      .mockResolvedValueOnce(page(agents.slice(400)));

    const result = await runLsCommand({ global: true }, new Command());
    const rows = JSON.parse(render(result, { format: "json" }));

    expect(rows.map((row: { id: string }) => row.id)).toEqual(
      agents.toReversed().map((agent) => agent.id),
    );
    expect(rows[0]).toEqual({
      id: agents[400].id,
      shortId: agents[400].id.slice(0, 7),
      name: "Agent 400",
      provider: "codex",
      thinking: "auto",
      status: "idle",
      cwd: "/tmp/project",
      created: expect.any(String),
    });
    expect(fetchAgents.mock.calls.map(([options]) => options)).toEqual([
      { sort: [{ key: "created_at", direction: "desc" }], page: { limit: 200 } },
      {
        sort: [{ key: "created_at", direction: "desc" }],
        page: { limit: 200, cursor: "page-2" },
      },
      {
        sort: [{ key: "created_at", direction: "desc" }],
        page: { limit: 200, cursor: "page-3" },
      },
    ]);
    expect(render(result, { quiet: true }).split("\n")).toHaveLength(401);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([0, 200])("stops at a terminal page containing %i agents", async (count) => {
    fetchAgents.mockResolvedValueOnce(
      page(Array.from({ length: count }, (_, index) => makeAgent(index))),
    );
    const result = await runLsCommand({}, new Command());
    expect(JSON.parse(render(result, { format: "json" }))).toHaveLength(count);
    expect(fetchAgents).toHaveBeenCalledTimes(1);
  });

  it.each<AgentLsOptions>([
    {},
    { global: true },
    { all: true },
    { global: true, background: true },
    { label: ["team=platform"], thinking: " medium " },
  ])("keeps scope and filters on every page: %j", async (options) => {
    fetchAgents.mockResolvedValueOnce(page([], "next")).mockResolvedValueOnce(page([]));
    await runLsCommand(options, new Command());
    for (const [request] of fetchAgents.mock.calls) {
      expect(request).toMatchObject(buildAgentLsFetchOptions(options));
      expect(request.sort).toEqual([{ key: "created_at", direction: "desc" }]);
    }
    expect(fetchAgents).toHaveBeenCalledTimes(2);
  });

  it("applies local filters to later pages and keeps the existing display order", async () => {
    const matching = { cwd: "/tmp/project/nested", labels: { team: "platform" } };
    fetchAgents
      .mockResolvedValueOnce(page([makeAgent(0, { cwd: "/tmp/other" })], "next"))
      .mockResolvedValueOnce(
        page([
          makeAgent(1, { ...matching, status: "running" }),
          makeAgent(2, { ...matching, status: "running" }),
          makeAgent(3, matching),
          makeAgent(4, { ...matching, archivedAt: "2026-01-02T00:00:00Z" }),
          makeAgent(5, { ...matching, labels: { team: "other" } }),
        ]),
      );
    const result = await runLsCommand(
      { cwd: "/tmp/project", status: "running", label: ["team=platform"] },
      new Command(),
    );
    expect(result.data.map((row) => row.id)).toEqual([makeAgent(2).id, makeAgent(1).id]);
  });

  it("rejects a later page failure instead of returning a partial inventory", async () => {
    fetchAgents
      .mockResolvedValueOnce(page([makeAgent(0)], "next"))
      .mockRejectedValueOnce(new Error("connection lost on page two"));
    await expect(runLsCommand({ global: true }, new Command())).rejects.toMatchObject({
      code: "LIST_AGENTS_FAILED",
      message: expect.stringContaining("connection lost on page two"),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { hasMore: true, nextCursor: null },
    { hasMore: true, nextCursor: "" },
    { hasMore: false, nextCursor: "unexpected" },
  ])("rejects invalid pagination metadata: %j", async (pageInfo) => {
    fetchAgents.mockResolvedValueOnce({ ...page([makeAgent(0)]), pageInfo });
    await expect(runLsCommand({}, new Command())).rejects.toMatchObject({
      code: "LIST_AGENTS_FAILED",
      message: expect.stringContaining("pagination"),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a cursor cycle instead of looping or returning partial results", async () => {
    fetchAgents
      .mockResolvedValueOnce(page([makeAgent(0)], "a"))
      .mockResolvedValueOnce(page([makeAgent(1)], "b"))
      .mockResolvedValueOnce(page([makeAgent(2)], "a"));
    await expect(runLsCommand({}, new Command())).rejects.toMatchObject({
      code: "LIST_AGENTS_FAILED",
      message: expect.stringContaining("pagination"),
    });
    expect(fetchAgents).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
