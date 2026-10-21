import { describe, expect, it } from "vitest";
import { workspaceTreeKeyboardDrop } from "./keyboard";
import {
  buildWorkspaceTree,
  projectWorkspaceTreeDrop,
  visibleWorkspaceTreeRows,
  workspaceTreeDescendants,
  type WorkspaceTreeItem,
} from "./tree";

function workspace(
  id: string,
  parentWorkspaceId: string | null = null,
  siblingOrder = 0,
  serverId = "host",
): WorkspaceTreeItem {
  return {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    parentWorkspaceId,
    siblingOrder,
  };
}

describe("workspace hierarchy", () => {
  it("supports keyboard sibling reorder, nesting and unparenting", () => {
    const rows = buildWorkspaceTree([workspace("parent"), workspace("child"), workspace("other")]);
    const input = { rows, visibleRows: rows, overKey: null };
    expect(
      workspaceTreeKeyboardDrop({ ...input, activeKey: "host:parent", code: "ArrowDown" })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "parent",
      parentWorkspaceId: null,
      beforeWorkspaceId: "other",
    });
    expect(
      workspaceTreeKeyboardDrop({ ...input, activeKey: "host:child", code: "ArrowRight" })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "child",
      parentWorkspaceId: "parent",
      beforeWorkspaceId: null,
    });
    const nested = buildWorkspaceTree([
      workspace("parent"),
      workspace("child", "parent"),
      workspace("other"),
    ]);
    expect(
      workspaceTreeKeyboardDrop({
        rows: nested,
        visibleRows: nested,
        overKey: null,
        activeKey: "host:child",
        code: "ArrowLeft",
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "child",
      parentWorkspaceId: null,
      beforeWorkspaceId: "other",
    });
  });
  it("sorts siblings using host order and renders descendants immediately after their parent", () => {
    const rows = buildWorkspaceTree([
      workspace("last", null, 5),
      workspace("child-2", "parent", 9),
      workspace("parent", null, 1),
      workspace("grandchild", "child-1"),
      workspace("child-1", "parent", 2),
    ]);
    expect(rows.map((row) => [row.workspace.workspaceId, row.depth])).toEqual([
      ["parent", 0],
      ["child-1", 1],
      ["grandchild", 2],
      ["child-2", 1],
      ["last", 0],
    ]);
    expect([...workspaceTreeDescendants(rows, "host:parent")]).toEqual([
      "host:child-1",
      "host:grandchild",
      "host:child-2",
    ]);
  });

  it("keeps a filtered descendant visible as a root and never attaches it to another host", () => {
    const rows = buildWorkspaceTree([
      workspace("parent", null, 0, "other"),
      workspace("child", "parent"),
    ]);
    expect(rows.map((row) => [row.workspace.workspaceKey, row.depth, row.parentKey])).toEqual([
      ["other:parent", 0, null],
      ["host:child", 0, null],
    ]);
  });

  it("collapses an entire subtree while keeping later roots visible", () => {
    const rows = buildWorkspaceTree([
      workspace("parent"),
      workspace("child", "parent"),
      workspace("grandchild", "child"),
      workspace("next"),
    ]);
    expect(
      visibleWorkspaceTreeRows({ rows, collapsedKeys: new Set(["host:parent"]) }).map(
        (row) => row.workspace.workspaceId,
      ),
    ).toEqual(["parent", "next"]);
    expect(
      visibleWorkspaceTreeRows({ rows, collapsedKeys: new Set(), draggingKey: "host:parent" }).map(
        (row) => row.workspace.workspaceId,
      ),
    ).toEqual(["parent", "next"]);
  });

  it("turns a middle drop into a real parent assignment", () => {
    const rows = buildWorkspaceTree([workspace("parent"), workspace("moving")]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:moving",
        targetKey: "host:parent",
        position: "inside",
      }),
    ).toEqual({
      targetKey: "host:parent",
      position: "inside",
      depth: 1,
      move: {
        serverId: "host",
        workspaceId: "moving",
        parentWorkspaceId: "parent",
        beforeWorkspaceId: null,
      },
    });
  });

  it("reorders siblings before and after without flattening their hierarchy", () => {
    const rows = buildWorkspaceTree([
      workspace("parent"),
      workspace("a", "parent", 1),
      workspace("b", "parent", 2),
      workspace("c", "parent", 3),
    ]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:c",
        targetKey: "host:b",
        position: "before",
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "c",
      parentWorkspaceId: "parent",
      beforeWorkspaceId: "b",
    });
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:a",
        targetKey: "host:b",
        position: "after",
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "a",
      parentWorkspaceId: "parent",
      beforeWorkspaceId: "c",
    });
  });

  it("outdents to the ancestor sibling boundary using a leftward drag", () => {
    const rows = buildWorkspaceTree([
      workspace("parent", null, 1),
      workspace("a", "parent", 1),
      workspace("b", "parent", 2),
      workspace("next", null, 2),
    ]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:b",
        targetKey: "host:a",
        position: "after",
        horizontalOffset: -20,
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "b",
      parentWorkspaceId: null,
      beforeWorkspaceId: "next",
    });
  });

  it("blocks self, descendant and cross-host drops", () => {
    const rows = buildWorkspaceTree([
      workspace("parent"),
      workspace("child", "parent"),
      workspace("grandchild", "child"),
      workspace("remote", null, 0, "other"),
    ]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:parent",
        targetKey: "host:parent",
        position: "inside",
      }),
    ).toBeNull();
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:parent",
        targetKey: "host:grandchild",
        position: "before",
      }),
    ).toBeNull();
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:child",
        targetKey: "other:remote",
        position: "inside",
      }),
    ).toBeNull();
  });

  it("aligns a deeper source to its shallower target before applying extra outdent", () => {
    const rows = buildWorkspaceTree([
      workspace("parent"),
      workspace("branch", "parent", 1),
      workspace("deep", "branch"),
      workspace("sibling", "parent", 2),
    ]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:deep",
        targetKey: "host:sibling",
        position: "before",
        horizontalOffset: -18,
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "deep",
      parentWorkspaceId: "parent",
      beforeWorkspaceId: "sibling",
    });
  });

  it("does not lose rows when a stale cache contains a parent cycle", () => {
    const rows = buildWorkspaceTree([workspace("a", "b"), workspace("b", "a")]);
    expect(rows.map((row) => [row.workspace.workspaceId, row.depth])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("keeps host forests contiguous because sibling ranks belong to one host", () => {
    const rows = buildWorkspaceTree([
      workspace("a1", null, 1024, "a"),
      workspace("b1", null, 1024, "b"),
      workspace("a2", null, 2048, "a"),
    ]);
    expect(rows.map((row) => row.workspace.workspaceKey)).toEqual(["a:a1", "a:a2", "b:b1"]);
    expect(
      projectWorkspaceTreeDrop({ rows, activeKey: "a:a2", targetKey: "a:a1", position: "after" })
        ?.move,
    ).toEqual({
      serverId: "a",
      workspaceId: "a2",
      parentWorkspaceId: null,
      beforeWorkspaceId: null,
    });
  });

  it("keeps authoritative parent membership when reordering beside a filtered orphan", () => {
    const rows = buildWorkspaceTree([
      workspace("orphan", "hidden", 1),
      workspace("sibling", "hidden", 2),
      workspace("moving"),
    ]);
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:moving",
        targetKey: "host:orphan",
        position: "before",
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "moving",
      parentWorkspaceId: "hidden",
      beforeWorkspaceId: "orphan",
    });
    expect(
      projectWorkspaceTreeDrop({
        rows,
        activeKey: "host:moving",
        targetKey: "host:orphan",
        position: "after",
      })?.move,
    ).toEqual({
      serverId: "host",
      workspaceId: "moving",
      parentWorkspaceId: "hidden",
      beforeWorkspaceId: "sibling",
    });
  });
});
