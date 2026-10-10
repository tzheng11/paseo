import type { SortableTreeItem, SortableTreeMove } from "@getpaseo/plugin/client/ui";

export function visibleTreeItems(items: readonly SortableTreeItem[]) {
  const rows: { item: SortableTreeItem; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    if (depth > 20) throw new Error("Tree nesting exceeds 20 levels");
    for (const item of items.filter((candidate) => candidate.parentId === parentId)) {
      rows.push({ item, depth });
      if (!item.collapsed) visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export function treeDropMove(
  items: readonly SortableTreeItem[],
  activeId: string,
  targetId: string | null,
  position: "before" | "inside" | "after" | "root",
): SortableTreeMove | null {
  const active = items.find((item) => item.id === activeId);
  const target = items.find((item) => item.id === targetId);
  if (!active || activeId === targetId || (position !== "root" && !target)) return null;
  let parentId: string | null = null;
  if (position === "inside") parentId = target!.id;
  else if (position !== "root") parentId = target!.parentId;
  if (position === "inside" && !target!.acceptsChildren) return null;
  let ancestor = parentId;
  const visited = new Set<string>();
  while (ancestor !== null) {
    if (ancestor === activeId || visited.has(ancestor)) return null;
    visited.add(ancestor);
    const parent = items.find((item) => item.id === ancestor);
    if (!parent) return null;
    ancestor = parent.parentId;
  }
  const siblings = items.filter((item) => item.parentId === parentId && item.id !== activeId);
  let beforeId: string | null = null;
  if (position === "before") beforeId = target!.id;
  else if (position === "after")
    beforeId = siblings[siblings.findIndex((item) => item.id === target!.id) + 1]?.id ?? null;
  return { id: activeId, parentId, beforeId };
}
