import { describe, expect, it } from "vitest";
import {
  movePinnedWorkspaceTree,
  collectPinnedWorkspaceSubtree,
  resolvePinnedWorkspaceTree,
  seedPinnedWorkspaceTree,
  type PinnedWorkspaceTree,
  type PinnedWorkspaceTreeItem,
} from "./pinned-layout";

function workspace(
  serverId: string,
  id: string,
  extra: Partial<PinnedWorkspaceTreeItem> = {},
): PinnedWorkspaceTreeItem {
  return {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    projectViewKey: "project",
    sidebarSection: "pinned",
    ...extra,
  };
}

describe("pinned workspace layout", () => {
  it("appends shared children after legacy sibling ranks without comparing section-root ranks", () => {
    const parent = workspace("one", "parent", { sidebarSection: "unpinned", siblingOrder: 99999 });
    const legacy = workspace("one", "legacy", {
      sidebarSection: "unpinned",
      parentWorkspaceId: "parent",
      siblingOrder: 8192,
    });
    const newChild = workspace("two", "new", {
      sidebarSection: "unpinned",
      projectViewKey: "other",
    });
    const otherRoot = workspace("two", "root", {
      sidebarSection: "unpinned",
      siblingOrder: -99999,
    });
    const tree = { "two:new": { parentWorkspaceKey: parent.workspaceKey, siblingOrder: 9216 } };
    const resolved = resolvePinnedWorkspaceTree([parent, newChild, otherRoot, legacy], tree);
    expect(resolved.get(legacy.workspaceKey)).toEqual({
      parentWorkspaceKey: parent.workspaceKey,
      siblingOrder: 8192,
    });
    expect(resolved.get(newChild.workspaceKey)?.siblingOrder).toBeGreaterThan(
      resolved.get(legacy.workspaceKey)!.siblingOrder,
    );
    expect(resolved.get(parent.workspaceKey)!.siblingOrder).toBeLessThan(
      resolved.get(otherRoot.workspaceKey)!.siblingOrder,
    );
    expect(parent.siblingOrder).toBe(99999);
    expect(otherRoot.siblingOrder).toBe(-99999);
  });

  it("collects full-key descendants, reports missing members and leaves other pin sections alone", () => {
    const workspaces = [
      workspace("one", "parent"),
      workspace("two", "child"),
      workspace("two", "priority", { sidebarSection: "superpinned" }),
    ];
    const tree = {
      "two:child": { parentWorkspaceKey: "one:parent", siblingOrder: 0.125 },
      "offline:child": { parentWorkspaceKey: "two:child", siblingOrder: 2 },
      "two:priority": { parentWorkspaceKey: "one:parent", siblingOrder: 3 },
    };
    expect(collectPinnedWorkspaceSubtree({ tree, workspaces, workspaceKey: "one:parent" })).toEqual(
      {
        workspaceKeys: ["one:parent", "two:child"],
        unavailableWorkspaceKeys: ["offline:child"],
      },
    );
    expect(
      movePinnedWorkspaceTree({
        tree,
        workspaces,
        workspaceKey: "one:parent",
        parentWorkspaceKey: "two:priority",
        beforeWorkspaceKey: null,
        section: "superpinned",
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unavailable"),
    });
  });

  it("retains a dormant group while unpinned and collects it for repinning", () => {
    const workspaces = [
      workspace("one", "parent", { sidebarSection: undefined }),
      workspace("two", "child", { sidebarSection: undefined }),
    ];
    const tree = { "two:child": { parentWorkspaceKey: "one:parent", siblingOrder: 0.125 } };
    expect(
      collectPinnedWorkspaceSubtree({ tree, workspaces, workspaceKey: "one:parent" }).workspaceKeys,
    ).toEqual(["one:parent", "two:child"]);
    const result = movePinnedWorkspaceTree({
      tree,
      workspaces,
      workspaceKey: "one:parent",
      parentWorkspaceKey: null,
      beforeWorkspaceKey: null,
      section: "pinned",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tree["two:child"]).toEqual(tree["two:child"]);
  });
  it("nests across hosts and projects without confusing identical workspace IDs", () => {
    const workspaces = [
      workspace("one", "same"),
      workspace("two", "same", { projectViewKey: "elsewhere" }),
    ];
    const moved = movePinnedWorkspaceTree({
      tree: {},
      workspaces,
      workspaceKey: "two:same",
      parentWorkspaceKey: "one:same",
      beforeWorkspaceKey: null,
      section: "pinned",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.tree["two:same"]).toEqual({
      parentWorkspaceKey: "one:same",
      siblingOrder: 0,
    });
    expect(
      resolvePinnedWorkspaceTree(workspaces, moved.tree).get("two:same")?.parentWorkspaceKey,
    ).toBe("one:same");
  });

  it("uses legacy parents only for explicit pins on the same host, project and section", () => {
    const parent = workspace("one", "parent");
    const child = workspace("one", "child", { parentWorkspaceId: "parent" });
    const otherProject = workspace("one", "project", {
      parentWorkspaceId: "parent",
      projectViewKey: "elsewhere",
    });
    const otherHost = workspace("two", "host", { parentWorkspaceId: "parent" });
    const priority = workspace("one", "priority", {
      parentWorkspaceId: "parent",
      sidebarSection: "superpinned",
    });
    const ordinary = workspace("one", "ordinary", {
      parentWorkspaceId: "parent",
      sidebarSection: undefined,
    });
    const result = resolvePinnedWorkspaceTree([
      parent,
      child,
      otherProject,
      otherHost,
      priority,
      ordinary,
    ]);
    expect(result.get(child.workspaceKey)?.parentWorkspaceKey).toBe(parent.workspaceKey);
    for (const item of [otherProject, otherHost, priority])
      expect(result.get(item.workspaceKey)?.parentWorkspaceKey).toBeNull();
    expect(result.has(ordinary.workspaceKey)).toBe(false);
  });

  it("honors explicit null and retains projected parent/rank on a second resolution", () => {
    const parent = workspace("one", "parent");
    const child = workspace("one", "child", {
      parentWorkspaceId: "parent",
      sidebarParentWorkspaceKey: null,
      siblingOrder: 0.125,
    });
    expect(resolvePinnedWorkspaceTree([parent, child]).get(child.workspaceKey)).toEqual({
      parentWorkspaceKey: null,
      siblingOrder: 0.125,
    });
    const nested = { ...child, sidebarParentWorkspaceKey: parent.workspaceKey };
    expect(resolvePinnedWorkspaceTree([parent, nested]).get(child.workspaceKey)).toEqual({
      parentWorkspaceKey: parent.workspaceKey,
      siblingOrder: 0.125,
    });
    const crossHostParent = workspace("two", "explicit-parent");
    const projected = {
      ...child,
      parentWorkspaceId: "offline-legacy-parent",
      sidebarParentWorkspaceKey: crossHostParent.workspaceKey,
    };
    expect(
      seedPinnedWorkspaceTree({}, [parent, projected, crossHostParent])[child.workspaceKey]
        ?.parentWorkspaceKey,
    ).toBe(crossHostParent.workspaceKey);
  });

  it("promotes a missing, unpinned or other-section parent without pruning its saved edge", () => {
    const child = workspace("one", "child");
    const tree: PinnedWorkspaceTree = {
      [child.workspaceKey]: {
        parentWorkspaceKey: "two:parent",
        siblingOrder: 0.125,
      },
    };
    for (const parent of [
      undefined,
      workspace("two", "parent", { sidebarSection: undefined }),
      workspace("two", "parent", { sidebarSection: "superpinned" }),
    ]) {
      expect(
        resolvePinnedWorkspaceTree(parent ? [child, parent] : [child], tree).get(child.workspaceKey)
          ?.parentWorkspaceKey,
      ).toBeNull();
      expect(seedPinnedWorkspaceTree(tree, [child])[child.workspaceKey]).toEqual(
        tree[child.workspaceKey],
      );
    }
    expect(
      resolvePinnedWorkspaceTree([child, workspace("two", "parent")], tree).get(child.workspaceKey)
        ?.parentWorkspaceKey,
    ).toBe("two:parent");
  });

  it("seeds legacy visual root order and child order while preserving all dormant entries", () => {
    const dormant = {
      parentWorkspaceKey: "offline:parent",
      siblingOrder: 12.5,
    };
    const workspaces = [
      workspace("one", "b", { siblingOrder: 99 }),
      workspace("one", "a", { siblingOrder: 0 }),
      workspace("one", "later", { parentWorkspaceId: "b", siblingOrder: 2 }),
      workspace("one", "first", { parentWorkspaceId: "b", siblingOrder: 1 }),
    ];
    const tree = seedPinnedWorkspaceTree({ "offline:child": dormant }, workspaces);
    expect(tree["one:b"]!.siblingOrder).toBeLessThan(tree["one:a"]!.siblingOrder);
    expect(tree["one:first"]!.siblingOrder).toBeLessThan(tree["one:later"]!.siblingOrder);
    expect(tree["offline:child"]).toBe(dormant);
    expect(seedPinnedWorkspaceTree(tree, workspaces)).toBe(tree);
    const orphan = workspace("one", "orphan", {
      parentWorkspaceId: "not-hydrated",
    });
    expect(seedPinnedWorkspaceTree(tree, [orphan])).not.toHaveProperty("one:orphan");
  });

  it("places newly seen pins after persisted ranks with a transitive deterministic order", () => {
    const workspaces = [workspace("one", "new"), workspace("one", "b"), workspace("one", "a")];
    const tree = {
      "one:b": { parentWorkspaceKey: null, siblingOrder: 0 },
      "one:a": { parentWorkspaceKey: null, siblingOrder: 1 },
    };
    const result = resolvePinnedWorkspaceTree(workspaces, tree);
    expect(
      [...result].sort((a, b) => a[1].siblingOrder - b[1].siblingOrder).map(([key]) => key),
    ).toEqual(["one:b", "one:a", "one:new"]);
    const seeded = seedPinnedWorkspaceTree(tree, workspaces);
    expect(seeded["one:b"]).toEqual(tree["one:b"]);
    expect(seeded["one:new"]!.siblingOrder).toBeGreaterThan(1);
  });

  it("makes corrupt cycles visible and refuses moves into raw saved cycles", () => {
    const workspaces = [workspace("one", "a"), workspace("two", "a"), workspace("one", "child")];
    const tree = {
      "one:a": { parentWorkspaceKey: "two:a", siblingOrder: 0 },
      "two:a": { parentWorkspaceKey: "one:a", siblingOrder: 1 },
      "one:child": { parentWorkspaceKey: "two:a", siblingOrder: 0 },
    };
    const result = resolvePinnedWorkspaceTree(workspaces, tree);
    expect(result.get("one:a")?.parentWorkspaceKey).toBeNull();
    expect(result.get("two:a")?.parentWorkspaceKey).toBeNull();
    expect(result.get("one:child")?.parentWorkspaceKey).toBe("two:a");
    expect(
      movePinnedWorkspaceTree({
        tree,
        workspaces,
        workspaceKey: "one:child",
        parentWorkspaceKey: "one:a",
        beforeWorkspaceKey: null,
        section: "pinned",
      }).ok,
    ).toBe(false);
    expect(
      movePinnedWorkspaceTree({
        tree,
        workspaces,
        workspaceKey: "one:a",
        parentWorkspaceKey: null,
        beforeWorkspaceKey: null,
        section: "pinned",
      }).ok,
    ).toBe(true);
  });

  it("refuses a descendant cycle through an offline saved node", () => {
    const workspaces = [workspace("one", "source"), workspace("two", "target")];
    const tree = {
      "offline:middle": { parentWorkspaceKey: "one:source", siblingOrder: 0 },
      "two:target": { parentWorkspaceKey: "offline:middle", siblingOrder: 0 },
    };
    expect(
      movePinnedWorkspaceTree({
        tree,
        workspaces,
        workspaceKey: "one:source",
        parentWorkspaceKey: "two:target",
        beforeWorkspaceKey: null,
        section: "pinned",
      }).ok,
    ).toBe(false);
  });

  it("inserts a fractional rank and moves a subtree without changing its descendants", () => {
    const workspaces = [
      workspace("one", "parent"),
      workspace("one", "low"),
      workspace("two", "high"),
      workspace("two", "source"),
      workspace("one", "child"),
    ];
    const tree = {
      "one:parent": { parentWorkspaceKey: null, siblingOrder: 0 },
      "one:low": { parentWorkspaceKey: "one:parent", siblingOrder: 0 },
      "two:high": { parentWorkspaceKey: "one:parent", siblingOrder: 0.25 },
      "two:source": { parentWorkspaceKey: null, siblingOrder: 10 },
      "one:child": { parentWorkspaceKey: "two:source", siblingOrder: 37 },
      "offline:saved": { parentWorkspaceKey: null, siblingOrder: 3 },
    };
    const result = movePinnedWorkspaceTree({
      tree,
      workspaces,
      workspaceKey: "two:source",
      parentWorkspaceKey: "one:parent",
      beforeWorkspaceKey: "two:high",
      section: "pinned",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.siblingOrder).toBe(0.125);
    expect(result.rebalanced).toBe(false);
    expect(result.tree["one:child"]).toBe(tree["one:child"]);
    expect(result.tree["offline:saved"]).toBe(tree["offline:saved"]);
    expect(tree["two:source"]).toEqual({ parentWorkspaceKey: null, siblingOrder: 10 });
  });

  it("rebalances only destination siblings when floating-point precision is exhausted", () => {
    const workspaces = [
      workspace("one", "left"),
      workspace("one", "right"),
      workspace("two", "source"),
      workspace("one", "priority", { sidebarSection: "superpinned" }),
    ];
    const tree = {
      "one:left": { parentWorkspaceKey: null, siblingOrder: 1 },
      "one:right": {
        parentWorkspaceKey: null,
        siblingOrder: 1 + Number.EPSILON,
      },
      "two:source": { parentWorkspaceKey: null, siblingOrder: 20 },
      "one:priority": { parentWorkspaceKey: null, siblingOrder: 91 },
    };
    const result = movePinnedWorkspaceTree({
      tree,
      workspaces,
      workspaceKey: "two:source",
      parentWorkspaceKey: null,
      beforeWorkspaceKey: "one:right",
      section: "pinned",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rebalanced).toBe(true);
    expect(result.tree["one:left"]!.siblingOrder).toBeLessThan(result.siblingOrder);
    expect(result.siblingOrder).toBeLessThan(result.tree["one:right"]!.siblingOrder);
    expect(result.tree["one:priority"]).toBe(tree["one:priority"]);
  });

  it("handles extreme finite endpoint ranks without persisting infinity or reversing new pins", () => {
    const workspaces = [workspace("one", "old"), workspace("two", "new")];
    const tree = {
      "one:old": { parentWorkspaceKey: null, siblingOrder: Number.MAX_VALUE },
    };
    const seeded = seedPinnedWorkspaceTree(tree, workspaces);
    expect(seeded).toEqual(tree);
    const result = movePinnedWorkspaceTree({
      tree,
      workspaces,
      workspaceKey: "two:new",
      parentWorkspaceKey: null,
      beforeWorkspaceKey: null,
      section: "pinned",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rebalanced).toBe(true);
    expect(Number.isFinite(result.siblingOrder)).toBe(true);
    expect(result.siblingOrder).toBeGreaterThan(result.tree["one:old"]!.siblingOrder);
  });

  it.each([undefined, null])(
    "retains an unresolved legacy parent with projected parent %s during an unrelated rebalance",
    (sidebarParentWorkspaceKey) => {
      const workspaces = [
        workspace("one", "orphan", {
          parentWorkspaceId: "offline-parent",
          sidebarParentWorkspaceKey,
          siblingOrder: 0,
        }),
        workspace("two", "source"),
        workspace("one", "last"),
      ];
      expect(seedPinnedWorkspaceTree({}, workspaces)).not.toHaveProperty("one:orphan");
      const explicitNull = { "one:orphan": { parentWorkspaceKey: null, siblingOrder: 0 } };
      expect(seedPinnedWorkspaceTree(explicitNull, workspaces)["one:orphan"]).toBe(
        explicitNull["one:orphan"],
      );
      const result = movePinnedWorkspaceTree({
        tree: {},
        workspaces,
        workspaceKey: "two:source",
        parentWorkspaceKey: null,
        beforeWorkspaceKey: "one:last",
        section: "pinned",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rebalanced).toBe(true);
      expect(result.tree["one:orphan"]?.parentWorkspaceKey).toBe("one:offline-parent");
      expect(
        resolvePinnedWorkspaceTree(
          [...workspaces, workspace("one", "offline-parent")],
          result.tree,
        ).get("one:orphan")?.parentWorkspaceKey,
      ).toBe("one:offline-parent");
    },
  );

  it("keeps unrelated unpinned groups and Superpinned placements out of a drag write", () => {
    const workspaces = [
      workspace("one", "source", { sidebarSection: "unpinned" }),
      workspace("two", "parent", { sidebarSection: "unpinned" }),
      workspace("two", "child", { sidebarSection: "unpinned", parentWorkspaceId: "parent" }),
      workspace("three", "priority", { sidebarSection: "superpinned" }),
    ];
    const tree = { "three:priority": { parentWorkspaceKey: null, siblingOrder: 99 } };
    const result = movePinnedWorkspaceTree({
      tree,
      workspaces,
      workspaceKey: "one:source",
      parentWorkspaceKey: "two:parent",
      beforeWorkspaceKey: null,
      section: "unpinned",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree["one:source"]?.parentWorkspaceKey).toBe("two:parent");
    // Destination siblings need shared ranks when first imported into one order.
    expect(result.tree["two:child"]?.parentWorkspaceKey).toBe("two:parent");
    expect(result.tree).not.toHaveProperty("two:parent");
    expect(result.tree["three:priority"]).toBe(tree["three:priority"]);
  });

  it.each(["unpinned", "superpinned"] as const)(
    "moves a full cross-host subtree to %s while preserving child ranks",
    (section) => {
      const workspaces = [
        workspace("one", "parent"),
        workspace("two", "hidden-child"),
        workspace("two", "leaf", { projectViewKey: "another-project" }),
        workspace("three", "priority", { sidebarSection: section }),
      ];
      const tree = {
        "two:hidden-child": { parentWorkspaceKey: "one:parent", siblingOrder: 0.125 },
        "two:leaf": { parentWorkspaceKey: "two:hidden-child", siblingOrder: 17 },
      };
      const move = (workspaceKey: string) =>
        movePinnedWorkspaceTree({
          tree,
          workspaces,
          workspaceKey,
          parentWorkspaceKey: "three:priority",
          beforeWorkspaceKey: null,
          section,
        });
      const group = move("one:parent");
      expect(group.ok).toBe(true);
      if (!group.ok) return;
      expect(group.tree["one:parent"]?.parentWorkspaceKey).toBe("three:priority");
      expect(group.tree["two:hidden-child"]).toEqual(tree["two:hidden-child"]);
      expect(group.tree["two:leaf"]).toEqual(tree["two:leaf"]);
      const destination = workspaces.map((item) => ({
        ...item,
        sidebarSection: section,
      }));
      const resolved = resolvePinnedWorkspaceTree(destination, group.tree);
      expect(resolved.get("two:hidden-child")?.parentWorkspaceKey).toBe("one:parent");
      expect(resolved.get("two:leaf")?.parentWorkspaceKey).toBe("two:hidden-child");
      const leaf = move("two:leaf");
      expect(leaf.ok).toBe(true);
      if (!leaf.ok) return;
      expect(leaf.tree["two:leaf"]?.parentWorkspaceKey).toBe("three:priority");
      expect(workspaces[2]!.sidebarSection).toBe("pinned");
    },
  );
});
