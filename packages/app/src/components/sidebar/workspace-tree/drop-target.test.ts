import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { shouldPinWorkspaceAfterDrop, reorderPinnedWorkspaceSubtree } from "./pin-placement";
import {
  resolveWorkspaceTreeDrop,
  resolveWorkspaceTreeDropResult,
  type WorkspaceTreeDrop,
} from "./drop-target";

function workspace(id: string, parent: string | null, order: number): SidebarWorkspacePlacement {
  return {
    workspaceKey: `host:${id}`,
    workspaceId: id,
    serverId: "host",
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    parentWorkspaceId: parent,
    siblingOrder: order,
  };
}
const workspaces = [
  workspace("a", null, 0),
  workspace("b", null, 1),
  workspace("c", "a", 0),
  workspace("d", "c", 0),
];

describe("workspace tree drops", () => {
  it("nests a workspace without changing its descendants", () => {
    expect(
      resolveWorkspaceTreeDrop({
        workspaces,
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:b",
        position: "inside",
      }),
    ).toEqual({
      workspaceKey: "host:a",
      targetWorkspaceKey: "host:b",
      position: "inside",
      parentWorkspaceId: "b",
      beforeWorkspaceId: null,
    });
  });
  it("rejects dropping a subtree into a descendant", () => {
    expect(
      resolveWorkspaceTreeDrop({
        workspaces,
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:d",
        position: "inside",
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceTreeDrop({
        workspaces,
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:d",
        position: "before",
      }),
    ).toBeNull();
  });
  it("resolves an after drop to the next persisted sibling", () => {
    const ordered = [...workspaces, workspace("e", null, 2)];
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: ordered,
        workspaceKey: "host:c",
        targetWorkspaceKey: "host:a",
        position: "after",
      }),
    ).toMatchObject({ parentWorkspaceId: null, beforeWorkspaceId: "b" });
  });
  it("rejects another host or project", () => {
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: [...workspaces, { ...workspace("x", null, 0), projectViewKey: "other" }],
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:x",
        position: "inside",
      }),
    ).toBeNull();
  });
  it("keeps cross-project pinned root ordering local without nesting", () => {
    const other = Object.assign(workspace("x", null, 0), { projectViewKey: "other" });
    const pinnedRootKeys = new Set(["host:a", "host:x"]);
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: [...workspaces, other],
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:x",
        position: "before",
        pinnedRootKeys,
      }),
    ).toMatchObject({ pinnedOrderOnly: true, position: "before" });
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: [...workspaces, other],
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:x",
        position: "inside",
        pinnedRootKeys,
      }),
    ).toBeNull();
  });
  it("explains a blocked cross-project nesting target without blocking pinned root ordering", () => {
    const other = { ...workspace("x", null, 0), projectViewKey: "other" };
    const input = {
      workspaces: [...workspaces, other],
      workspaceKey: "host:a",
      targetWorkspaceKey: "host:x",
      pinnedRootKeys: new Set(["host:a", "host:x"]),
    };
    expect(resolveWorkspaceTreeDropResult({ ...input, position: "inside" })).toEqual({
      drop: null,
      rejection: {
        targetWorkspaceKey: "host:x",
        message: "Use a workspace in the same project to nest",
      },
    });
    expect(resolveWorkspaceTreeDropResult({ ...input, position: "before" })).toMatchObject({
      drop: { pinnedOrderOnly: true, position: "before" },
      rejection: null,
    });
  });
  it("explains cross-host nesting and descendant cycles", () => {
    const remote = {
      ...workspace("remote", null, 0),
      serverId: "remote",
      workspaceKey: "remote:remote",
    };
    expect(
      resolveWorkspaceTreeDropResult({
        workspaces: [...workspaces, remote],
        workspaceKey: "host:a",
        targetWorkspaceKey: "remote:remote",
        position: "inside",
      }),
    ).toEqual({
      drop: null,
      rejection: {
        targetWorkspaceKey: "remote:remote",
        message: "Use a workspace on the same host to nest",
      },
    });
    expect(
      resolveWorkspaceTreeDropResult({
        workspaces,
        workspaceKey: "host:a",
        targetWorkspaceKey: "host:d",
        position: "inside",
      }),
    ).toEqual({
      drop: null,
      rejection: {
        targetWorkspaceKey: "host:d",
        message: "A workspace cannot be moved into one of its children",
      },
    });
  });
  it("keeps self hover and leaving the list quiet", () => {
    for (const targetWorkspaceKey of ["host:a", ""]) {
      expect(
        resolveWorkspaceTreeDropResult({
          workspaces,
          workspaceKey: "host:a",
          targetWorkspaceKey,
          position: "inside",
        }),
      ).toEqual({ drop: null, rejection: null });
    }
  });
  it("inserts next to an orphan displayed at the root", () => {
    const orphan = workspace("orphan", "archived-parent", 0.5);
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: [...workspaces, orphan],
        workspaceKey: "host:c",
        targetWorkspaceKey: "host:orphan",
        position: "before",
      }),
    ).toMatchObject({ parentWorkspaceId: null, beforeWorkspaceId: "orphan" });
    expect(
      resolveWorkspaceTreeDrop({
        workspaces: [...workspaces, orphan],
        workspaceKey: "host:c",
        targetWorkspaceKey: "host:a",
        position: "after",
      }),
    ).toMatchObject({ parentWorkspaceId: null, beforeWorkspaceId: "orphan" });
  });
  it("keeps a hidden active parent's identity when inserting by its child", () => {
    expect(
      resolveWorkspaceTreeDrop({
        workspaces,
        workspaceKey: "host:b",
        targetWorkspaceKey: "host:c",
        position: "before",
      }),
    ).toMatchObject({ parentWorkspaceId: "a", beforeWorkspaceId: "c" });
  });
});

describe("workspace tree drop section", () => {
  const rootDrop: WorkspaceTreeDrop = {
    workspaceKey: "host:b",
    targetWorkspaceKey: "host:a",
    position: "before",
    parentWorkspaceId: null,
    beforeWorkspaceId: "a",
  };
  const pinnedKeys = new Set(["host:a", "host:c", "host:d"]);
  it("pins a workspace dropped beside a pinned display root", () => {
    expect(shouldPinWorkspaceAfterDrop(rootDrop, "host", pinnedKeys)).toBe(true);
  });
  it("inherits a pinned parent without keeping a separate pin", () => {
    expect(
      shouldPinWorkspaceAfterDrop(
        { ...rootDrop, position: "inside", parentWorkspaceId: "a", beforeWorkspaceId: null },
        "host",
        pinnedKeys,
      ),
    ).toBe(false);
    expect(
      shouldPinWorkspaceAfterDrop(
        {
          ...rootDrop,
          targetWorkspaceKey: "host:c",
          parentWorkspaceId: "a",
          beforeWorkspaceId: "c",
        },
        "host",
        pinnedKeys,
      ),
    ).toBe(false);
  });
  it("unpins a subtree moved to an unpinned parent", () => {
    expect(
      shouldPinWorkspaceAfterDrop(
        {
          ...rootDrop,
          workspaceKey: "host:a",
          targetWorkspaceKey: "host:b",
          position: "inside",
          parentWorkspaceId: "b",
          beforeWorkspaceId: null,
        },
        "host",
        pinnedKeys,
      ),
    ).toBe(false);
  });
  it("places a newly pinned subtree beside the requested root without duplicating pinned descendants", () => {
    const withChild = [...workspaces, workspace("e", "b", 0)];
    const ordered = reorderPinnedWorkspaceSubtree({
      workspaces: withChild,
      pinnedWorkspaces: [workspaces[0]!, workspaces[2]!, workspaces[3]!, withChild[4]!],
      drop: rootDrop,
    });
    expect(ordered?.map((item) => item.workspaceId)).toEqual(["b", "e", "a", "c", "d"]);
  });
});
