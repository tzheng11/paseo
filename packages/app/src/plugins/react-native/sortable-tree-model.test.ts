import { describe, expect, it } from "vitest";
import { treeDropMove, visibleTreeItems } from "./sortable-tree-model";
const items = [
  { id: "a", parentId: null, label: "A", acceptsChildren: true },
  { id: "child", parentId: "a", label: "Child", acceptsChildren: true },
  { id: "b", parentId: null, label: "B", acceptsChildren: true },
  { id: "work", parentId: "a", label: "Work", acceptsChildren: false },
];
describe("tree drop destinations", () => {
  it("flattens visible rows in tree order and hides a collapsed subtree", () => {
    expect(visibleTreeItems(items).map(({ item, depth }) => [item.id, depth])).toEqual([
      ["a", 0],
      ["child", 1],
      ["work", 1],
      ["b", 0],
    ]);
    expect(
      visibleTreeItems(items.map((item) => ({ ...item, collapsed: item.id === "a" }))).map(
        (row) => row.item.id,
      ),
    ).toEqual(["a", "b"]);
  });
  it("supports insertion before/after, nesting and returning to the root", () => {
    expect(treeDropMove(items, "b", "child", "before")).toEqual({
      id: "b",
      parentId: "a",
      beforeId: "child",
    });
    expect(treeDropMove(items, "b", "child", "after")).toEqual({
      id: "b",
      parentId: "a",
      beforeId: "work",
    });
    expect(treeDropMove(items, "work", "b", "inside")).toEqual({
      id: "work",
      parentId: "b",
      beforeId: null,
    });
    expect(treeDropMove(items, "work", null, "root")).toEqual({
      id: "work",
      parentId: null,
      beforeId: null,
    });
  });
  it("rejects self/descendant targets, workspace parents and missing references", () => {
    expect(treeDropMove(items, "a", "child", "inside")).toBeNull();
    expect(treeDropMove(items, "a", "child", "before")).toBeNull();
    expect(treeDropMove(items, "a", "work", "inside")).toBeNull();
    expect(treeDropMove(items, "a", "a", "inside")).toBeNull();
    expect(treeDropMove(items, "missing", "b", "inside")).toBeNull();
  });
});
