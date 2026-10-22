import { describe, expect, it } from "vitest";
import { captureVisiblePinnedOrder } from "./capture-pinned-order";
import {
  movePinnedWorkspaceTree,
  resolvePinnedWorkspaceTree,
  type PinnedWorkspaceTree,
  type PinnedWorkspaceTreeItem,
} from "./pinned-layout";

function workspace(
  key: string,
  extra: Partial<PinnedWorkspaceTreeItem> = {},
): PinnedWorkspaceTreeItem {
  return {
    workspaceKey: key,
    serverId: key.split(":")[0]!,
    projectViewKey: "project",
    sidebarSection: "pinned",
    sidebarParentWorkspaceKey: null,
    ...extra,
  };
}

function rootKeys(
  workspaces: readonly PinnedWorkspaceTreeItem[],
  tree: PinnedWorkspaceTree,
): string[] {
  const resolved = resolvePinnedWorkspaceTree(workspaces, tree);
  const roots = [...resolved].filter(([, placement]) => placement.parentWorkspaceKey === null);
  roots.sort((left, right) => left[1].siblingOrder - right[1].siblingOrder);
  return roots.map(([key]) => key);
}

describe("capture visible pinned order", () => {
  it("keeps the displayed alphabetical order when a drag switches to manual ordering", () => {
    const [a, b, c] = [workspace("host:a"), workspace("host:b"), workspace("host:c")];
    const workspaces = [c!, b!, a!];
    const tree = {
      "host:c": { parentWorkspaceKey: null, siblingOrder: 0 },
      "host:b": { parentWorkspaceKey: null, siblingOrder: 1 },
      "host:a": { parentWorkspaceKey: null, siblingOrder: 2 },
    };
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [a!, b!, c!],
      section: "pinned",
    });
    expect(rootKeys(workspaces, captured)).toEqual(["host:a", "host:b", "host:c"]);
    const moved = movePinnedWorkspaceTree({
      tree: captured,
      workspaces,
      workspaceKey: "host:c",
      parentWorkspaceKey: null,
      beforeWorkspaceKey: "host:b",
      section: "pinned",
    });
    if (!moved.ok) throw new Error(moved.reason);
    expect(rootKeys(workspaces, moved.tree)).toEqual(["host:a", "host:c", "host:b"]);
    expect(tree["host:c"]).toEqual({ parentWorkspaceKey: null, siblingOrder: 0 });
  });

  it("captures roots and each child group independently without changing descendants or parents", () => {
    const parent = workspace("one:parent");
    const otherRoot = workspace("two:root");
    const a = workspace("two:a", { sidebarParentWorkspaceKey: parent.workspaceKey });
    const b = workspace("one:b", { sidebarParentWorkspaceKey: parent.workspaceKey });
    const c = workspace("three:c", { sidebarParentWorkspaceKey: parent.workspaceKey });
    const grandchild = workspace("three:grandchild", { sidebarParentWorkspaceKey: b.workspaceKey });
    const workspaces = [parent, c, b, grandchild, a, otherRoot];
    const tree = {
      [parent.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 0 },
      [otherRoot.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 1024 },
      [c.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 0 },
      [b.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 1 },
      [a.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 2 },
      [grandchild.workspaceKey]: { parentWorkspaceKey: b.workspaceKey, siblingOrder: 37 },
    };
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [otherRoot, parent, a, b, grandchild, c],
      section: "pinned",
    });
    expect(rootKeys(workspaces, captured)).toEqual([otherRoot.workspaceKey, parent.workspaceKey]);
    expect([a, b, c].map((item) => captured[item.workspaceKey])).toEqual([
      { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 0 },
      { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 1024 },
      { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 2048 },
    ]);
    expect(captured[grandchild.workspaceKey]).toBe(tree[grandchild.workspaceKey]);
  });

  it("keeps hidden sibling slots while replacing the visible order", () => {
    const a = workspace("host:a");
    const b = workspace("host:b");
    const c = workspace("host:c");
    const hidden = workspace("remote:hidden");
    const workspaces = [c, hidden, b, a];
    const tree = {
      [c.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 0 },
      [hidden.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 1 },
      [b.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 2 },
      [a.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 3 },
    };
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [a, b, c],
      section: "pinned",
    });
    expect(rootKeys(workspaces, captured)).toEqual([
      a.workspaceKey,
      hidden.workspaceKey,
      b.workspaceKey,
      c.workspaceKey,
    ]);
    expect(captured[hidden.workspaceKey]).toEqual({ parentWorkspaceKey: null, siblingOrder: 1024 });
  });

  it.each([undefined, null])(
    "retains an unknown legacy parent when the projected parent is %s",
    (sidebarParentWorkspaceKey) => {
      const root = workspace("host:root");
      const orphan = workspace("host:orphan", {
        parentWorkspaceId: "not-hydrated",
        sidebarParentWorkspaceKey,
      });
      const workspaces = [root, orphan];
      const captured = captureVisiblePinnedOrder({
        tree: {},
        workspaces,
        visibleWorkspaces: [orphan, root],
        section: "pinned",
      });
      expect(captured[orphan.workspaceKey]).toEqual({
        parentWorkspaceKey: "host:not-hydrated",
        siblingOrder: 0,
      });
      const hydrated = resolvePinnedWorkspaceTree(
        [...workspaces, workspace("host:not-hydrated")],
        captured,
      );
      expect(hydrated.get(orphan.workspaceKey)?.parentWorkspaceKey).toBe("host:not-hydrated");
    },
  );

  it("keeps saved explicit null authoritative over an unknown legacy parent", () => {
    const root = workspace("host:root");
    const orphan = workspace("host:orphan", { parentWorkspaceId: "not-hydrated" });
    const workspaces = [root, orphan];
    const tree = {
      [root.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 0 },
      [orphan.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 1 },
    };
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [orphan, root],
      section: "pinned",
    });
    expect(captured[orphan.workspaceKey]).toEqual({ parentWorkspaceKey: null, siblingOrder: 0 });
  });

  it("preserves a known projected full-key parent over a missing legacy parent", () => {
    const parent = workspace("remote:parent");
    const child = workspace("host:child", {
      parentWorkspaceId: "old-offline-parent",
      sidebarParentWorkspaceKey: parent.workspaceKey,
      siblingOrder: 0,
    });
    const sibling = workspace("remote:sibling", { sidebarParentWorkspaceKey: parent.workspaceKey });
    const workspaces = [parent, child, sibling];
    const tree = {
      [parent.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 0 },
      [sibling.workspaceKey]: { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 1024 },
    };
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [parent, sibling, child],
      section: "pinned",
    });
    expect(captured[child.workspaceKey]).toEqual({
      parentWorkspaceKey: parent.workspaceKey,
      siblingOrder: 1024,
    });
  });

  it("retains other sections and dormant edges and returns the existing tree when order is unchanged", () => {
    const a = workspace("host:a");
    const b = workspace("host:b");
    const priority = workspace("remote:priority", { sidebarSection: "superpinned" });
    const workspaces = [a, b, priority];
    const tree = {
      [a.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 0 },
      [b.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 1024 },
      [priority.workspaceKey]: { parentWorkspaceKey: null, siblingOrder: 37 },
      "offline:child": { parentWorkspaceKey: "offline:parent", siblingOrder: 0.125 },
    };
    const unchanged = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [a, b, priority],
      section: "pinned",
    });
    expect(unchanged).toBe(tree);
    const captured = captureVisiblePinnedOrder({
      tree,
      workspaces,
      visibleWorkspaces: [b, a, priority],
      section: "pinned",
    });
    expect(captured[priority.workspaceKey]).toBe(tree[priority.workspaceKey]);
    expect(captured["offline:child"]).toBe(tree["offline:child"]);
    expect(tree[a.workspaceKey]).toEqual({ parentWorkspaceKey: null, siblingOrder: 0 });
  });
});
