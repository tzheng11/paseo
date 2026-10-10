import { describe, expect, it } from "vitest";
import {
  descendants,
  migrateOrganization,
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
  it("preserves nested folders, cross-host workspace leaves and links", () => {
    expect(organizationSchema.parse({})).toEqual({ nodes: [] });
    const parent = folder("project");
    const childFolder = folder("development", parent.id);
    const studio = workspace("studio", "same", parent.id);
    const child = workspace("laptop", "same", childFolder.id);
    const document = organizationSchema.parse({
      nodes: [
        parent,
        childFolder,
        studio,
        {
          ...child,
          links: [{ id: "notion", title: "Project", url: "https://app.notion.com/p/project" }],
        },
      ],
    });
    expect(document.nodes).toHaveLength(4);
    expect(document.nodes[3].parentId).toBe(childFolder.id);
    expect(workspaceIdentity("a:b", "c")).not.toBe(workspaceIdentity("a", "b:c"));
  });

  it.each(["folder", "workspace"])("rejects a %s inside a workspace", (kind) => {
    const parent = workspace("studio", "parent");
    const child =
      kind === "folder" ? folder("child", parent.id) : workspace("laptop", "child", parent.id);
    const result = organizationSchema.safeParse({ nodes: [parent, child] });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].message).toBe("Only folders can contain entries");
  });

  it("upgrades workspace parents to their nearest folder without losing order or links", () => {
    const project = folder("project");
    const studio = workspace("studio", "parent", project.id);
    const laptop = workspace("laptop", "child", studio.id);
    const nested = {
      ...folder("nested", laptop.id),
      links: [{ id: "n", title: "Project", url: "https://notion.so/project" }],
    };
    const rootWorkspace = workspace("other", "root");
    const rootChild = workspace("other", "child", rootWorkspace.id);
    const result = migrateOrganization(
      { nodes: [project, studio, laptop, nested, rootWorkspace, rootChild] },
      1,
    );
    expect(result.nodes.map((node) => node.parentId)).toEqual([
      null,
      project.id,
      project.id,
      project.id,
      null,
      null,
    ]);
    expect(result.nodes[3].links).toEqual(nested.links);
    expect(result.nodes.map((node) => node.id)).toEqual(
      [project, studio, laptop, nested, rootWorkspace, rootChild].map((node) => node.id),
    );
  });

  it("refuses corrupt migration input instead of discarding saved data", () => {
    const a = workspace("studio", "a", "studio-b");
    const b = workspace("studio", "b", "studio-a");
    expect(() => migrateOrganization({ nodes: [a, b] }, 1)).toThrow("cycle");
    expect(() => migrateOrganization({ nodes: [folder("a", "missing")] }, 1)).toThrow(
      "missing parent",
    );
    expect(() => migrateOrganization({ nodes: [] }, 3)).toThrow("Unsupported");
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
