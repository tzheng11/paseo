import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import {
  buildPinnedSidebarKeys,
  arePinnedSidebarKeysEqual,
  splitPinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId: "s1",
    workspaceId: workspaceKey,
    projectViewKey: "p1",
    projectName: "Project 1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}

function pinKeys(workspaces: SidebarWorkspacePlacement[]): PinnedSidebarKeys {
  const keys = workspaces.map((workspace) => workspace.workspaceKey);
  return {
    pinnedWorkspaceKeys: keys,
    pinnedAtByKey: Object.fromEntries(keys.map((key) => [key, "2026-01-01T00:00:00Z"])),
    superpinnedAtByKey: {},
  };
}

describe("splitPinnedSidebarGroups", () => {
  it("keeps pin membership independent while nesting explicitly pinned legacy children", () => {
    const parent = { ...placement("s1:parent"), workspaceId: "parent", siblingOrder: 1 };
    const child = {
      ...placement("s1:child"),
      workspaceId: "child",
      parentWorkspaceId: "parent",
      siblingOrder: 2,
    };
    const grandchild = {
      ...placement("s1:grandchild"),
      workspaceId: "grandchild",
      parentWorkspaceId: "child",
      siblingOrder: 3,
    };
    const other = { ...placement("s1:other"), workspaceId: "other", siblingOrder: 4 };
    const result = splitPinnedSidebarGroups({
      projects: [project("p1", [parent, child, grandchild, other])],
      keys: {
        pinnedWorkspaceKeys: [parent.workspaceKey, child.workspaceKey],
        superpinnedAtByKey: {},
        pinnedAtByKey: {
          [parent.workspaceKey]: "2026-01-01T00:00:00Z",
          [child.workspaceKey]: "2026-02-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats.map((workspace) => workspace.workspaceId)).toEqual([
      "parent",
      "child",
    ]);
    expect(
      result.unpinnedProjects[0]?.workspaces.map((workspace) => workspace.workspaceId),
    ).toEqual(["grandchild", "other"]);
  });

  it("keeps the project shell reachable when every chat is pinned", () => {
    const only = placement("w1");
    const projects = [project("p1", [only])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        superpinnedAtByKey: {},
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toEqual([{ ...projects[0], workspaces: [] }]);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], superpinnedAtByKey: {}, pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
    });
    expect(result.unpinnedProjects).toHaveLength(1);
  });

  it("keeps remaining chats when only some are pinned", () => {
    const projects = [project("p1", [placement("w1"), placement("w2")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        superpinnedAtByKey: {},
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats.map((w) => w.workspaceKey)).toEqual(["w1"]);
    expect(result.unpinnedProjects[0]?.workspaces.map((w) => w.workspaceKey)).toEqual(["w2"]);
  });

  it("orders pinned chats by most-recently-pinned first", () => {
    const projects = [project("p1", [placement("older"), placement("newer")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer"],
        superpinnedAtByKey: {},
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: [],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("applies the saved order while keeping a newly pinned chat first", () => {
    const projects = [project("p1", [placement("older"), placement("newer"), placement("new")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer", "new"],
        superpinnedAtByKey: {},
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["older", "newer"],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });

  it("uses full-key cross-host parents and layout ranks before deterministic new-pin fallbacks", () => {
    const parent = { ...placement("s1:parent"), workspaceId: "parent" };
    const otherParent = {
      ...placement("remote:parent"),
      workspaceId: "parent",
      serverId: "remote",
      projectViewKey: "p2",
    };
    const child = {
      ...placement("remote:child"),
      workspaceId: "child",
      serverId: "remote",
      projectViewKey: "p2",
    };
    const newPin = { ...placement("s1:new"), workspaceId: "new" };
    const workspaces = [parent, otherParent, child, newPin];
    const result = splitPinnedSidebarGroups({
      projects: [project("p1", [parent, newPin]), project("p2", [otherParent, child])],
      keys: pinKeys(workspaces),
      pinnedWorkspaceOrder: [parent.workspaceKey, child.workspaceKey, otherParent.workspaceKey],
      pinnedWorkspaceTree: {
        [parent.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 20 },
        [otherParent.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 10 },
        [child.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 0.125 },
      },
    });
    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      otherParent.workspaceKey,
      parent.workspaceKey,
      child.workspaceKey,
      newPin.workspaceKey,
    ]);
    expect(
      result.pinnedChats.find((workspace) => workspace.workspaceKey === child.workspaceKey),
    ).toMatchObject({
      sidebarParentWorkspaceKey: parent.workspaceKey,
      sidebarSection: "pinned",
      siblingOrder: 0.125,
    });
    expect(result.unpinnedProjects.map((entry) => entry.workspaces)).toEqual([[], []]);
    expect(child.sidebarParentWorkspaceKey).toBeUndefined();
  });

  it("promotes children when a parent leaves their section without deleting dormant layout edges", () => {
    const parent = { ...placement("s1:parent"), workspaceId: "parent" };
    const child = {
      ...placement("remote:child"),
      workspaceId: "child",
      serverId: "remote",
      projectViewKey: "p2",
    };
    const tree = {
      [child.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 5 },
    };
    const input = {
      projects: [project("p1", [parent]), project("p2", [child])],
      keys: pinKeys([child]),
      pinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: tree,
    };
    const unpinnedParent = splitPinnedSidebarGroups(input);
    expect(
      unpinnedParent.pinnedChats.map((workspace) => [
        workspace.workspaceKey,
        workspace.sidebarParentWorkspaceKey,
      ]),
    ).toEqual([[child.workspaceKey, null]]);
    expect(unpinnedParent.unpinnedProjects[0]?.workspaces).toEqual([parent]);
    const promotedParent = splitPinnedSidebarGroups({
      ...input,
      keys: {
        ...pinKeys([parent, child]),
        superpinnedAtByKey: { [parent.workspaceKey]: "2026-01-02T00:00:00Z" },
      },
    });
    expect(promotedParent.superpinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      parent.workspaceKey,
    ]);
    expect(
      promotedParent.pinnedChats.map((workspace) => [
        workspace.workspaceKey,
        workspace.sidebarParentWorkspaceKey,
      ]),
    ).toEqual([[child.workspaceKey, null]]);
    const filteredParent = splitPinnedSidebarGroups({
      ...input,
      projects: [project("p2", [child])],
    });
    expect(filteredParent.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      child.workspaceKey,
    ]);
    const restored = splitPinnedSidebarGroups({ ...input, keys: pinKeys([parent, child]) });
    expect(
      restored.pinnedChats.map((workspace) => [
        workspace.workspaceKey,
        workspace.sidebarParentWorkspaceKey,
      ]),
    ).toEqual([
      [parent.workspaceKey, null],
      [child.workspaceKey, parent.workspaceKey],
    ]);
    expect(tree).toEqual({
      [child.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 5 },
    });
  });

  it("keeps a persisted explicit root even when the daemon still has a legacy parent", () => {
    const parent = { ...placement("s1:parent"), workspaceId: "parent" };
    const child = { ...placement("s1:child"), workspaceId: "child", parentWorkspaceId: "parent" };
    const result = splitPinnedSidebarGroups({
      projects: [project("p1", [parent, child])],
      keys: pinKeys([parent, child]),
      pinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: { [child.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 1 } },
    });
    expect(
      result.pinnedChats.find((workspace) => workspace.workspaceKey === child.workspaceKey),
    ).toMatchObject({ parentWorkspaceId: "parent", sidebarParentWorkspaceKey: null });
    expect(child.parentWorkspaceId).toBe("parent");
  });
});

const UNIQUE_KEY = "3fdb71dd-7bc7-81c1-8df8-e1a11aa86938@0b7e04dd45da#unique-section";
const ORDER_KEY = "3fdb71dd-7bc7-819c-a877-cd75ea604d90@4f2db58109a2#order";

it(`${UNIQUE_KEY} selects each promoted row once and invalidates a pin-only memo`, () => {
  const projects = [project("p1", [placement("w1"), placement("w2")])];
  const workspaces = new Map([
    ["w1", { pinnedAt: "2026-10-18T00:00:00Z", superpinnedAt: null as string | null }],
    ["w2", { pinnedAt: "2026-10-18T00:00:00Z", superpinnedAt: null as string | null }],
  ]);
  const maps = new Map([["s1", workspaces]]);
  const before = buildPinnedSidebarKeys(projects, maps);
  workspaces.set("w1", { ...workspaces.get("w1")!, superpinnedAt: "2026-10-18T01:00:00Z" });
  const keys = buildPinnedSidebarKeys(projects, maps);
  expect(arePinnedSidebarKeysEqual(before, keys)).toBe(false);
  const result = splitPinnedSidebarGroups({ projects, keys, pinnedWorkspaceOrder: [] });
  expect(result.superpinnedChats.map((w) => w.workspaceKey)).toEqual(["w1"]);
  expect(result.pinnedChats.map((w) => w.workspaceKey)).toEqual(["w2"]);
  expect(result.unpinnedProjects[0]?.workspaces).toEqual([]);
  expect(maps.get("s1")?.get("w1")?.superpinnedAt).toBe("2026-10-18T01:00:00Z");
});

it(`${ORDER_KEY} sorts daemon time then host and ID, ignoring saved pin order`, () => {
  const workspaces = [
    { ...placement("later-host"), serverId: "s2", workspaceId: "a" },
    { ...placement("later-id"), workspaceId: "z" },
    { ...placement("older"), workspaceId: "b" },
    { ...placement("first"), workspaceId: "a" },
  ];
  const projects = [project("p1", workspaces)];
  const maps = new Map(
    workspaces.map((w) => [
      w.workspaceKey,
      {
        pinnedAt: "2026-10-18T00:00:00Z",
        superpinnedAt: w.workspaceKey === "older" ? "2026-10-18T01:00:00Z" : "2026-10-18T02:00:00Z",
      },
    ]),
  );
  const keys = buildPinnedSidebarKeys(
    projects,
    new Map([
      [
        "s1",
        new Map(
          workspaces
            .filter((w) => w.serverId === "s1")
            .map((w) => [w.workspaceId, maps.get(w.workspaceKey)!]),
        ),
      ],
      ["s2", new Map([["a", maps.get("later-host")!]])],
    ]),
  );
  const result = splitPinnedSidebarGroups({
    projects,
    keys,
    pinnedWorkspaceOrder: workspaces.map((w) => w.workspaceKey),
  });
  expect(result.superpinnedChats.map((w) => w.workspaceKey)).toEqual([
    "first",
    "later-id",
    "later-host",
    "older",
  ]);
  expect([...maps.values()].filter((w) => w.superpinnedAt === "2026-10-18T02:00:00Z")).toHaveLength(
    3,
  );
});

it("keeps superpin daemon order until a separate subtree reorder is saved", () => {
  const parent = Object.assign(placement("s1:parent"), { workspaceId: "parent", siblingOrder: 1 });
  const child = Object.assign(placement("s1:child"), {
    workspaceId: "child",
    parentWorkspaceId: "parent",
    siblingOrder: 1,
  });
  const newer = Object.assign(placement("s1:newer"), { workspaceId: "newer", siblingOrder: 2 });
  const input = {
    projects: [project("p1", [parent, child, newer])],
    keys: {
      pinnedWorkspaceKeys: [parent.workspaceKey, child.workspaceKey, newer.workspaceKey],
      pinnedAtByKey: {},
      superpinnedAtByKey: {
        [parent.workspaceKey]: "2026-10-18T01:00:00Z",
        [child.workspaceKey]: "2026-10-18T01:30:00Z",
        [newer.workspaceKey]: "2026-10-18T02:00:00Z",
      },
    },
    pinnedWorkspaceOrder: [parent.workspaceKey, newer.workspaceKey],
  };
  expect(
    splitPinnedSidebarGroups(input).superpinnedChats.map((workspace) => workspace.workspaceId),
  ).toEqual(["newer", "parent", "child"]);
  const reordered = splitPinnedSidebarGroups({
    ...input,
    superpinnedWorkspaceOrder: [parent.workspaceKey, newer.workspaceKey],
  });
  expect(reordered.superpinnedChats.map((workspace) => workspace.workspaceId)).toEqual([
    "parent",
    "child",
    "newer",
  ]);
  expect(reordered.pinnedChats).toEqual([]);
  expect(reordered.unpinnedProjects[0]?.workspaces).toEqual([]);
});
