import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolveWorkspaceKeyboardDrop } from "./keyboard-drop";

function workspace(id: string, parentWorkspaceId: string | null = null): SidebarWorkspacePlacement {
  return {
    workspaceKey: `host:${id}`,
    serverId: "host",
    workspaceId: id,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    parentWorkspaceId,
    siblingOrder: id.charCodeAt(0),
    name: id,
  };
}

describe("workspace keyboard drops", () => {
  const workspaces = [workspace("a"), workspace("b"), workspace("c"), workspace("d", "b")];
  const base = {
    workspaces,
    workspaceKey: "host:a",
    targetKeys: ["host:a", "host:b", "host:d", "host:c"],
    currentDrop: null,
  };

  it("reorders vertically without implicitly nesting", () => {
    const after = resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowDown" });
    expect(after).toMatchObject({
      targetWorkspaceKey: "host:b",
      position: "after",
      parentWorkspaceId: null,
      beforeWorkspaceId: "c",
    });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowUp", currentDrop: after }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "before", parentWorkspaceId: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowDown", currentDrop: after }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceId: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:c", code: "ArrowUp" }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "before", parentWorkspaceId: null });
  });

  it("nests only on Right and lifts out on Left", () => {
    const after = resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowDown" });
    const inside = resolveWorkspaceKeyboardDrop({
      ...base,
      code: "ArrowRight",
      currentDrop: after,
    });
    expect(inside).toMatchObject({
      targetWorkspaceKey: "host:b",
      position: "inside",
      parentWorkspaceId: "b",
    });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowLeft", currentDrop: inside }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "after", parentWorkspaceId: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:d", code: "ArrowLeft" }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "after", parentWorkspaceId: null });
  });

  it("indents under the preceding sibling rather than its expanded descendant", () => {
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:c", code: "ArrowRight" }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "inside", parentWorkspaceId: "b" });
  });

  it("uses rendered targets and skips invalid descendants and other projects", () => {
    expect(
      resolveWorkspaceKeyboardDrop({
        ...base,
        targetKeys: ["host:a", "host:c"],
        code: "ArrowDown",
      }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceId: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:b", code: "ArrowDown" }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceId: null });
    const other = { ...workspace("x"), projectViewKey: "other" };
    expect(
      resolveWorkspaceKeyboardDrop({
        ...base,
        workspaces: [...workspaces, other],
        targetKeys: ["host:a", "host:x", "host:c"],
        code: "ArrowDown",
      }),
    ).toMatchObject({ targetWorkspaceKey: "host:c" });
  });

  it("keeps pinned roots reorderable across projects without nesting them", () => {
    const other = { ...workspace("x"), projectViewKey: "other" };
    const input = {
      ...base,
      workspaces: [...workspaces, other],
      targetKeys: ["host:a", "host:x"],
      pinnedRootKeys: new Set(["host:a", "host:x"]),
    };
    const after = resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowDown" });
    expect(after).toMatchObject({
      targetWorkspaceKey: "host:x",
      position: "after",
      pinnedOrderOnly: true,
    });
    expect(
      resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowRight", currentDrop: after }),
    ).toBeNull();
  });

  it("reorders and indents an orphan promoted to the root after its parent is archived", () => {
    const orphan = workspace("o", "archived-parent");
    const input = {
      ...base,
      workspaces: [...workspaces, orphan],
      workspaceKey: orphan.workspaceKey,
      targetKeys: ["host:a", orphan.workspaceKey, "host:b"],
    };
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowDown" })).toMatchObject({
      targetWorkspaceKey: "host:b",
      position: "after",
      parentWorkspaceId: null,
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowUp" })).toMatchObject({
      targetWorkspaceKey: "host:a",
      position: "before",
      parentWorkspaceId: null,
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowRight" })).toMatchObject({
      targetWorkspaceKey: "host:a",
      position: "inside",
      parentWorkspaceId: "a",
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowLeft" })).toBeNull();
  });
});
