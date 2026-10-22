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
    sidebarSection: "pinned",
    sidebarParentWorkspaceKey: parentWorkspaceId ? `host:${parentWorkspaceId}` : null,
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
      parentWorkspaceKey: null,
      beforeWorkspaceKey: "host:c",
    });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowUp", currentDrop: after }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "before", parentWorkspaceKey: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowDown", currentDrop: after }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceKey: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:c", code: "ArrowUp" }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "before", parentWorkspaceKey: null });
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
      parentWorkspaceKey: "host:b",
    });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, code: "ArrowLeft", currentDrop: inside }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "after", parentWorkspaceKey: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:d", code: "ArrowLeft" }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "after", parentWorkspaceKey: null });
  });

  it("indents under the preceding sibling rather than its expanded descendant", () => {
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:c", code: "ArrowRight" }),
    ).toMatchObject({
      targetWorkspaceKey: "host:b",
      position: "inside",
      parentWorkspaceKey: "host:b",
    });
  });

  it("uses rendered targets and skips invalid descendants and other pin sections", () => {
    expect(
      resolveWorkspaceKeyboardDrop({
        ...base,
        targetKeys: ["host:a", "host:c"],
        code: "ArrowDown",
      }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceKey: null });
    expect(
      resolveWorkspaceKeyboardDrop({ ...base, workspaceKey: "host:b", code: "ArrowDown" }),
    ).toMatchObject({ targetWorkspaceKey: "host:c", position: "after", parentWorkspaceKey: null });
    const other = {
      ...workspace("x"),
      projectViewKey: "other",
      sidebarSection: "superpinned" as const,
    };
    expect(
      resolveWorkspaceKeyboardDrop({
        ...base,
        workspaces: [...workspaces, other],
        targetKeys: ["host:a", "host:x", "host:c"],
        code: "ArrowDown",
      }),
    ).toMatchObject({ targetWorkspaceKey: "host:c" });
  });

  it("nests across projects and lifts using a cross-host full parent key", () => {
    const remote = {
      ...workspace("a"),
      serverId: "remote",
      workspaceKey: "remote:a",
      projectViewKey: "other",
    };
    const input = {
      ...base,
      workspaces: [...workspaces, remote],
      workspaceKey: "remote:a",
      targetKeys: ["host:b", "host:d", "remote:a"],
    };
    const nested = resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowRight" });
    expect(nested).toMatchObject({ parentWorkspaceKey: "host:b", pinnedOrderOnly: true });
    expect(
      resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowLeft", currentDrop: nested }),
    ).toMatchObject({ targetWorkspaceKey: "host:b", position: "after", parentWorkspaceKey: null });
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
      parentWorkspaceKey: null,
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowUp" })).toMatchObject({
      targetWorkspaceKey: "host:a",
      position: "before",
      parentWorkspaceKey: null,
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowRight" })).toMatchObject({
      targetWorkspaceKey: "host:a",
      position: "inside",
      parentWorkspaceKey: "host:a",
    });
    expect(resolveWorkspaceKeyboardDrop({ ...input, code: "ArrowLeft" })).toBeNull();
  });
});
