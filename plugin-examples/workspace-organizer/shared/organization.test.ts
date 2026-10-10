import { describe, expect, it } from "vitest";
import {
  descendants,
  moveNode,
  organizationSchema,
  removeNode,
  updateNode,
  workspaceIdentity,
  type OrganizationNode,
} from "./organization";

const folder = (id: string, parentId: string | null = null): OrganizationNode => ({
  id,
  parentId,
  kind: "folder",
  title: id,
  links: [],
});
const workspace = (
  serverId: string,
  workspaceId: string,
  parentId: string | null = null,
): OrganizationNode => ({
  id: `${serverId}-${workspaceId}`,
  kind: "workspace",
  serverId,
  workspaceId,
  parentId,
  title: workspaceId,
  links: [],
});

describe("shared workspace organization", () => {
  it("starts empty and preserves cross-host references, nested workspaces and links", () => {
    expect(organizationSchema.parse({})).toEqual({ nodes: [] });
    const parent = workspace("studio", "same");
    const child = workspace("laptop", "same", parent.id);
    const document = organizationSchema.parse({
      nodes: [
        parent,
        {
          ...child,
          links: [{ id: "notion", title: "Project", url: "https://app.notion.com/p/project" }],
        },
      ],
    });
    expect(document.nodes).toHaveLength(2);
    expect(document.nodes[1].parentId).toBe(parent.id);
    expect(workspaceIdentity("a:b", "c")).not.toBe(workspaceIdentity("a", "b:c"));
  });

  it.each([
    [folder("a"), folder("a")],
    [folder("a", "missing")],
    [folder("a", "a")],
    [folder("a", "b"), folder("b", "c"), folder("c", "a")],
    [workspace("studio", "a"), { ...workspace("studio", "a"), id: "another" }],
  ])("rejects duplicate identities, missing parents and cycles (%#)", (...nodes) => {
    expect(organizationSchema.safeParse({ nodes }).success).toBe(false);
  });

  it("refuses unsafe links and duplicate link IDs", () => {
    for (const url of ["javascript:alert(1)", "file:///tmp/a", "http://notion.so/a", "/relative"]) {
      expect(
        organizationSchema.safeParse({
          nodes: [{ ...folder("a"), links: [{ id: "l", title: "Project", url }] }],
        }).success,
      ).toBe(false);
    }
    const link = { id: "l", title: "Project", url: "https://notion.so/a" };
    expect(
      organizationSchema.safeParse({ nodes: [{ ...folder("a"), links: [link, link] }] }).success,
    ).toBe(false);
  });

  it("reorders siblings while preserving children and unrelated branches", () => {
    const document = organizationSchema.parse({
      nodes: [folder("a"), folder("child", "a"), folder("b"), folder("other", "b")],
    });
    const result = moveNode(document, "b", -1);
    expect(result.nodes.filter((node) => node.parentId === null).map((node) => node.id)).toEqual([
      "b",
      "a",
    ]);
    expect(result.nodes.find((node) => node.id === "child")?.parentId).toBe("a");
    expect(moveNode(result, "b", -1)).toBe(result);
    expect(moveNode(result, "a", -1)).toEqual(document);
  });

  it("promotes children in place when removing a reference without removing a workspace", () => {
    const document = organizationSchema.parse({
      nodes: [
        folder("before"),
        folder("parent"),
        folder("after"),
        workspace("studio", "a", "parent"),
        folder("child", "parent"),
      ],
    });
    const result = removeNode(document, "parent");
    expect(result.nodes.map((node) => node.id)).toEqual(["before", "studio-a", "child", "after"]);
    expect(result.nodes.every((node) => node.parentId === null)).toBe(true);
  });

  it("finds descendants and rejects moving a parent inside its child", () => {
    const parent = folder("parent");
    const child = folder("child", parent.id);
    const document = organizationSchema.parse({ nodes: [parent, child, folder("other")] });
    expect([...descendants(document.nodes, parent.id)]).toEqual(["parent", "child"]);
    expect(() => updateNode(document, { ...parent, parentId: child.id })).toThrow();
  });
});
