import { describe, expect, it } from "vitest";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { sortSidebarWorkspaces } from "./workspace-sort";

function workspace(input: {
  id: string;
  name?: string;
  branch?: string | null;
  activityAt?: Date | null;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${input.id}`,
    serverId: "srv",
    workspaceId: input.id,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "repo",
    name: input.name ?? input.id,
    title: null,
    currentBranch: input.branch ?? null,
    lastActivityAt: input.activityAt ?? null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function entries(workspaces: readonly SidebarWorkspaceEntry[]) {
  return new Map(workspaces.map((entry) => [entry.workspaceKey, entry]));
}

describe("sortSidebarWorkspaces", () => {
  it("preserves manual order in a separate array without changing rows", () => {
    const workspaces = Object.freeze([workspace({ id: "z" }), workspace({ id: "a" })]);
    const sorted = sortSidebarWorkspaces({
      workspaces,
      mode: "manual",
      workspaceTitleSource: "title",
      workspaceEntriesByKey: entries(workspaces),
    });
    expect(sorted).toEqual(workspaces);
    expect(sorted).not.toBe(workspaces);
    expect(sorted[0]).toBe(workspaces[0]);
  });

  it("orders visible names naturally without mutating the manual baseline", () => {
    const workspaces = Object.freeze([
      workspace({ id: "z", name: "Zeta" }),
      workspace({ id: "a10", name: "alpha 10" }),
      workspace({ id: "a2", name: "Alpha 2" }),
    ]);
    expect(
      sortSidebarWorkspaces({
        workspaces,
        mode: "alphabetical",
        workspaceTitleSource: "title",
        workspaceEntriesByKey: entries(workspaces),
      }).map((entry) => entry.workspaceId),
    ).toEqual(["a2", "a10", "z"]);
    expect(workspaces.map((entry) => entry.workspaceId)).toEqual(["z", "a10", "a2"]);
  });

  it("uses the displayed branch label and falls back to the workspace name", () => {
    const workspaces = [
      workspace({ id: "one", name: "Alpha", branch: "zeta-branch" }),
      workspace({ id: "two", name: "Beta" }),
    ];
    expect(
      sortSidebarWorkspaces({
        workspaces,
        mode: "alphabetical",
        workspaceTitleSource: "branch",
        workspaceEntriesByKey: entries(workspaces),
      }).map((entry) => entry.workspaceId),
    ).toEqual(["two", "one"]);
  });

  it("sorts the newest activity first, independently of status entry time", () => {
    const recent = workspace({ id: "recent", activityAt: new Date(3_000) });
    recent.statusEnteredAt = new Date(0);
    const older = workspace({ id: "older", activityAt: new Date(1_000) });
    older.statusEnteredAt = new Date(10_000);
    const workspaces = Object.freeze([older, recent]);
    expect(
      sortSidebarWorkspaces({
        workspaces,
        mode: "activity",
        workspaceTitleSource: "title",
        workspaceEntriesByKey: entries(workspaces),
      }).map((entry) => entry.workspaceId),
    ).toEqual(["recent", "older"]);
    expect(workspaces).toEqual([older, recent]);
  });

  it("puts missing and invalid activity after valid dates with deterministic ties", () => {
    const workspaces = [
      workspace({ id: "z-missing" }),
      workspace({ id: "invalid", activityAt: new Date("invalid") }),
      workspace({ id: "recent-z", activityAt: new Date(0) }),
      workspace({ id: "a-missing" }),
      workspace({ id: "recent-a", activityAt: new Date(0) }),
    ];
    const input = {
      workspaces,
      mode: "activity" as const,
      workspaceTitleSource: "title" as const,
      workspaceEntriesByKey: entries(workspaces),
    };
    const expected = ["recent-a", "recent-z", "a-missing", "invalid", "z-missing"];
    expect(sortSidebarWorkspaces(input).map((entry) => entry.workspaceId)).toEqual(expected);
    expect(
      sortSidebarWorkspaces({ ...input, workspaces: workspaces.toReversed() }).map(
        (entry) => entry.workspaceId,
      ),
    ).toEqual(expected);
  });

  it("uses placement names before entry hydration and preserves the placement shape", () => {
    const first = workspace({ id: "one", name: "Zulu" });
    const second = workspace({ id: "two", name: "Alpha" });
    const workspaces: SidebarWorkspacePlacement[] = [first, second];
    const sorted = sortSidebarWorkspaces({
      workspaces,
      mode: "alphabetical",
      workspaceTitleSource: "title",
      workspaceEntriesByKey: new Map(),
    });
    expect(sorted).toEqual([second, first]);
    expect(sorted[0]).toBe(second);
  });

  it("resorts when an authoritative activity snapshot advances", () => {
    const first = workspace({ id: "first", activityAt: new Date(1_000) });
    const second = workspace({ id: "second", activityAt: new Date(2_000) });
    const workspaces = [first, second];
    const input = {
      workspaces,
      mode: "activity" as const,
      workspaceTitleSource: "title" as const,
      workspaceEntriesByKey: entries(workspaces),
    };
    expect(sortSidebarWorkspaces(input).map((entry) => entry.workspaceId)).toEqual([
      "second",
      "first",
    ]);
    const nextEntries = entries([{ ...first, lastActivityAt: new Date(3_000) }, second]);
    expect(
      sortSidebarWorkspaces({ ...input, workspaceEntriesByKey: nextEntries }).map(
        (entry) => entry.workspaceId,
      ),
    ).toEqual(["first", "second"]);
  });
});
