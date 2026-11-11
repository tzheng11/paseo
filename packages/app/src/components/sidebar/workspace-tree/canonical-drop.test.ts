import { expect, test } from "vitest";
import {
  emptyWorkspaceNavigationPreferences,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import { canonicalWorkspaceDrop } from "./canonical-drop";
const now = "2026-11-04T12:00:00.000Z";
function entry(serverId: string, workspaceId: string): WorkspaceLayoutEntry {
  return {
    ref: { serverId, workspaceId },
    projectId: "project",
    pinnedAt: null,
    superpinnedAt: null,
    parent: null,
    siblingOrder: null,
    pinPlacement: null,
    archivedAt: null,
    revision: 3,
  };
}
function state(entries: WorkspaceLayoutEntry[]): WorkspaceLayoutSnapshot {
  return {
    stamp: {
      authorityServerId: "hub",
      authorityId: "00000000-0000-4000-8000-000000000001",
      epoch: "00000000-0000-4000-8000-000000000002",
      revision: 7,
      phase: "active",
    },
    entries,
    imports: [],
    clientImports: [],
    navigation: {
      revision: 2,
      preferences: emptyWorkspaceNavigationPreferences(),
      clientSources: [],
      resolutionSha256: "a".repeat(64),
    },
  };
}

test("a cross-host project move writes full identities and shared order without ranking unrelated hosts", () => {
  const snapshot = state([
    entry("a", "same"),
    entry("b", "same"),
    { ...entry("c", "saved"), archivedAt: now, pinnedAt: now },
  ]);
  snapshot.navigation!.preferences.workspaceOrderByProject.view = ["a:same", "b:same", "c:saved"];
  const input = {
    snapshot,
    now,
    catalog: [
      { workspaceKey: "a:same", projectViewKey: "view" },
      { workspaceKey: "b:same", projectViewKey: "view" },
    ],
    projectOrder: ["a:same", "b:same"],
    drop: {
      workspaceKey: "b:same",
      targetWorkspaceKey: "a:same",
      position: "before" as const,
      parentWorkspaceId: null,
      beforeWorkspaceId: "same",
    },
  };
  const mutations = canonicalWorkspaceDrop(input);
  expect(mutations).toHaveLength(2);
  expect(mutations[0]).toMatchObject({
    kind: "put",
    entry: { ref: { serverId: "b", workspaceId: "same" }, siblingOrder: null },
  });
  expect(mutations[1]).toMatchObject({
    kind: "put-navigation",
    expectedRevision: 2,
    preferences: { workspaceOrderByProject: { view: ["b:same", "a:same", "c:saved"] } },
  });
  expect(snapshot.entries[2]).toMatchObject({ archivedAt: now, pinnedAt: now });
  expect(snapshot.navigation!.preferences.workspaceOrderByProject.view).toEqual([
    "a:same",
    "b:same",
    "c:saved",
  ]);
});

test("moving a pinned subtree to superpins changes membership and placements in one transaction", () => {
  const parent = {
    ...entry("a", "parent"),
    pinnedAt: now,
    pinPlacement: { parentWorkspaceKey: null, siblingOrder: 0, revision: 1 },
  };
  const child = {
    ...entry("b", "child"),
    pinnedAt: now,
    pinPlacement: { parentWorkspaceKey: "a:parent", siblingOrder: 8, revision: 2 },
  };
  const target = {
    ...entry("c", "target"),
    pinnedAt: now,
    superpinnedAt: now,
    pinPlacement: { parentWorkspaceKey: null, siblingOrder: 0, revision: 1 },
  };
  const mutations = canonicalWorkspaceDrop({
    snapshot: state([parent, child, target]),
    now,
    catalog: [
      { workspaceKey: "a:parent", sidebarSection: "pinned" },
      { workspaceKey: "b:child", sidebarSection: "pinned" },
      { workspaceKey: "c:target", sidebarSection: "superpinned" },
    ],
    projectOrder: [],
    drop: {
      workspaceKey: "a:parent",
      targetWorkspaceKey: "c:target",
      position: "inside",
      parentWorkspaceId: null,
      beforeWorkspaceId: null,
      parentWorkspaceKey: "c:target",
      beforeWorkspaceKey: null,
      pinSection: "superpinned",
    },
  });
  const puts = mutations.flatMap((mutation) => (mutation.kind === "put" ? [mutation.entry] : []));
  expect(puts.find((row) => row.ref.workspaceId === "parent")).toMatchObject({
    superpinnedAt: now,
    pinPlacement: { parentWorkspaceKey: "c:target" },
  });
  expect(puts.find((row) => row.ref.workspaceId === "child")).toMatchObject({
    superpinnedAt: now,
  });
  expect(mutations.at(-1)).toMatchObject({ kind: "put-navigation", expectedRevision: 2 });
});

test("stale section or unavailable targets refuse before returning any mutation", () => {
  const snapshot = state([{ ...entry("a", "one"), pinnedAt: now }, entry("b", "two")]);
  expect(() =>
    canonicalWorkspaceDrop({
      snapshot,
      now,
      catalog: [
        { workspaceKey: "a:one", projectViewKey: "view" },
        { workspaceKey: "b:two", projectViewKey: "view" },
      ],
      projectOrder: [],
      drop: {
        workspaceKey: "a:one",
        targetWorkspaceKey: "b:two",
        position: "before",
        parentWorkspaceId: null,
        beforeWorkspaceId: null,
      },
    }),
  ).toThrow("pin sections changed");
});

test.each(["pinned", "superpinned"] as const)(
  "an archived child's dormant edge does not block a live parent's %s move",
  (destination) => {
    const parent = {
      ...entry("a", "parent"),
      pinnedAt: now,
      pinPlacement: { parentWorkspaceKey: null, siblingOrder: 0, revision: 1 },
    };
    const child = {
      ...entry("b", "archived"),
      archivedAt: now,
      pinnedAt: now,
      pinPlacement: { parentWorkspaceKey: "a:parent", siblingOrder: 8, revision: 2 },
    };
    const target = {
      ...entry("c", "target"),
      pinnedAt: now,
      superpinnedAt: destination === "superpinned" ? now : null,
      pinPlacement: { parentWorkspaceKey: null, siblingOrder: 1024, revision: 1 },
    };
    const snapshot = state([parent, child, target]);
    const mutations = canonicalWorkspaceDrop({
      snapshot,
      now,
      catalog: [
        { workspaceKey: "a:parent", sidebarSection: "pinned" },
        { workspaceKey: "c:target", sidebarSection: destination },
      ],
      projectOrder: [],
      drop: {
        workspaceKey: "a:parent",
        targetWorkspaceKey: "c:target",
        position: "before",
        parentWorkspaceId: null,
        beforeWorkspaceId: "target",
        parentWorkspaceKey: null,
        beforeWorkspaceKey: "c:target",
        pinSection: destination,
      },
    });
    expect(
      mutations.some(
        (mutation) => mutation.kind === "put" && mutation.entry.ref.workspaceId === "parent",
      ),
    ).toBe(true);
    expect(
      mutations.some(
        (mutation) => mutation.kind === "put" && mutation.entry.ref.workspaceId === "archived",
      ),
    ).toBe(false);
    expect(snapshot.entries[1]).toEqual(child);
  },
);

test("switching global sort for one project preserves every other visible unsaved order", () => {
  const snapshot = state([entry("a", "one"), entry("b", "two")]);
  snapshot.navigation!.preferences.workspaceSort = "created";
  snapshot.navigation!.preferences.workspaceOrderByProject.saved = ["z:old"];
  const mutations = canonicalWorkspaceDrop({
    snapshot,
    now,
    catalog: [
      { workspaceKey: "a:one", projectViewKey: "moved" },
      { workspaceKey: "b:two", projectViewKey: "moved" },
    ],
    projectOrder: ["a:one", "b:two"],
    projects: [
      {
        viewKey: "untouched",
        workspaces: [{ workspaceKey: "z:newer" }, { workspaceKey: "z:older" }],
      },
      { viewKey: "saved", workspaces: [{ workspaceKey: "z:new" }] },
    ],
    drop: {
      workspaceKey: "b:two",
      targetWorkspaceKey: "a:one",
      position: "before",
      parentWorkspaceId: null,
      beforeWorkspaceId: "one",
    },
  });
  expect(mutations.at(-1)).toMatchObject({
    kind: "put-navigation",
    preferences: {
      workspaceSort: "manual",
      workspaceOrderByProject: {
        moved: ["b:two", "a:one"],
        untouched: ["z:newer", "z:older"],
        saved: ["z:old"],
      },
    },
  });
});
