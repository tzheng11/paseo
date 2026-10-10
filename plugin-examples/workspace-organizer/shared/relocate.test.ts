import { describe, expect, it } from "vitest";
import { organizationSchema, relocateNode, type OrganizationNode } from "./organization";

const folder = (id: string, parentId: string | null = null): OrganizationNode => ({
  kind: "folder",
  id,
  parentId,
  title: id,
  links: [],
});
const document = organizationSchema.parse({
  nodes: [
    folder("A"),
    folder("child", "A"),
    folder("B"),
    {
      kind: "workspace",
      id: "work",
      parentId: "A",
      title: "Work",
      links: [],
      serverId: "remote",
      workspaceId: "workspace",
    },
  ],
});

describe("shared tree moves", () => {
  it("reorders roots without moving or losing their descendants", () => {
    const moved = relocateNode(document, { id: "B", parentId: null, beforeId: "A" });
    expect(moved.nodes.filter((node) => node.parentId === null).map((node) => node.id)).toEqual([
      "B",
      "A",
    ]);
    expect(moved.nodes.find((node) => node.id === "child")?.parentId).toBe("A");
  });
  it("moves a folder subtree into another folder and back to the root", () => {
    const nested = relocateNode(document, { id: "A", parentId: "B", beforeId: null });
    expect(nested.nodes.find((node) => node.id === "A")?.parentId).toBe("B");
    expect(nested.nodes.find((node) => node.id === "child")?.parentId).toBe("A");
    const restored = relocateNode(nested, { id: "A", parentId: null, beforeId: "B" });
    expect(restored.nodes.filter((node) => node.parentId === null).map((node) => node.id)).toEqual([
      "A",
      "B",
    ]);
  });
  it("moves a remote workspace reference before a sibling and preserves its host identity", () => {
    const moved = relocateNode(document, { id: "work", parentId: "B", beforeId: null });
    expect(moved.nodes.find((node) => node.id === "work")).toMatchObject({
      parentId: "B",
      serverId: "remote",
      workspaceId: "workspace",
    });
  });
  it("rejects self/descendant nesting, workspace parents, missing targets and stale anchors", () => {
    for (const input of [
      { id: "A", parentId: "A", beforeId: null },
      { id: "A", parentId: "child", beforeId: null },
      { id: "B", parentId: "work", beforeId: null },
      { id: "missing", parentId: null, beforeId: null },
      { id: "B", parentId: null, beforeId: "child" },
    ])
      expect(() => relocateNode(document, input)).toThrow();
    expect(document.nodes.filter((node) => node.parentId === null).map((node) => node.id)).toEqual([
      "A",
      "B",
    ]);
  });
});
