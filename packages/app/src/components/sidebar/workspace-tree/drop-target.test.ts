import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolveWorkspaceTreeDrop, resolveWorkspaceTreeDropResult } from "./drop-target";
function workspace(id: string, parent: string | null = null, order = 0): SidebarWorkspacePlacement {
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
    sidebarSection: "pinned",
    sidebarParentWorkspaceKey: parent ? `host:${parent}` : null,
  };
}
const workspaces = [
  workspace("a", null, 0),
  workspace("b", null, 1),
  workspace("c", "a", 0),
  workspace("d", "c", 0),
];
const input = {
  workspaces,
  workspaceKey: "host:a",
  targetWorkspaceKey: "host:b",
  position: "inside" as const,
};
describe("pinned workspace tree drops", () => {
  it("nests locally with full keys and no backend parent", () => {
    expect(resolveWorkspaceTreeDrop(input)).toMatchObject({
      parentWorkspaceId: null,
      beforeWorkspaceId: null,
      parentWorkspaceKey: "host:b",
      beforeWorkspaceKey: null,
      pinSection: "pinned",
      pinnedOrderOnly: true,
    });
  });
  it("allows cross-host/project nesting even with identical bare IDs", () => {
    const remote = {
      ...workspace("a"),
      workspaceKey: "remote:a",
      serverId: "remote",
      projectViewKey: "other",
    };
    expect(
      resolveWorkspaceTreeDrop({
        ...input,
        workspaces: [...workspaces, remote],
        workspaceKey: "remote:a",
        targetWorkspaceKey: "host:a",
      }),
    ).toMatchObject({ parentWorkspaceKey: "host:a", pinnedOrderOnly: true });
  });
  it("rejects every drop into its own subtree", () => {
    for (const position of ["inside", "before", "after"] as const)
      expect(
        resolveWorkspaceTreeDrop({ ...input, targetWorkspaceKey: "host:d", position }),
      ).toBeNull();
  });
  it("orders siblings with full identities", () => {
    const e = workspace("e", "a", 2);
    expect(
      resolveWorkspaceTreeDrop({
        ...input,
        workspaces: [...workspaces, e],
        workspaceKey: "host:b",
        targetWorkspaceKey: "host:c",
        position: "after",
      }),
    ).toMatchObject({ parentWorkspaceKey: "host:a", beforeWorkspaceKey: "host:e" });
  });
  it("treats an orphan as a visible root", () => {
    const orphan = workspace("o", "archived", 0.5);
    expect(
      resolveWorkspaceTreeDrop({
        ...input,
        workspaces: [...workspaces, orphan],
        targetWorkspaceKey: orphan.workspaceKey,
        position: "before",
      }),
    ).toMatchObject({ parentWorkspaceKey: null, beforeWorkspaceKey: "host:o" });
  });
  it("checks hidden descendants before crossing sections, but allows leaves", () => {
    const target = { ...workspace("s"), sidebarSection: "superpinned" as const };
    expect(
      resolveWorkspaceTreeDropResult({
        ...input,
        workspaces: [workspaces[0]!, target],
        allWorkspaces: [...workspaces, target],
        targetWorkspaceKey: target.workspaceKey,
      }),
    ).toMatchObject({ drop: null, rejection: { message: expect.stringContaining("children") } });
    expect(
      resolveWorkspaceTreeDrop({
        ...input,
        workspaces: [...workspaces, target],
        workspaceKey: "host:b",
        targetWorkspaceKey: target.workspaceKey,
      }),
    ).toMatchObject({ pinSection: "superpinned", parentWorkspaceKey: "host:s" });
  });
  it("keeps self and outside hover quiet", () => {
    for (const targetWorkspaceKey of ["host:a", ""])
      expect(resolveWorkspaceTreeDropResult({ ...input, targetWorkspaceKey })).toEqual({
        drop: null,
        rejection: null,
      });
  });
  it("keeps ordinary lists flat and explains where nesting is supported", () => {
    const ordinary = workspaces.map((w) =>
      Object.assign({}, w, { sidebarSection: undefined, sidebarParentWorkspaceKey: null }),
    );
    expect(resolveWorkspaceTreeDropResult({ ...input, workspaces: ordinary })).toMatchObject({
      drop: null,
      rejection: { message: "Pin workspaces to nest them in Pinned or SuperPinned" },
    });
    expect(
      resolveWorkspaceTreeDrop({ ...input, workspaces: ordinary, position: "before" }),
    ).toMatchObject({ parentWorkspaceId: null, beforeWorkspaceId: "b" });
  });
});
