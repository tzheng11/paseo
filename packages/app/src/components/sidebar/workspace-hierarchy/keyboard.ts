import { projectWorkspaceTreeDrop, type WorkspaceTreeDrop, type WorkspaceTreeRow } from "./tree";

/** Keyboard moves use the same before/inside/after contract as pointer drop zones. */
export function workspaceTreeKeyboardDrop(input: {
  rows: readonly WorkspaceTreeRow[];
  visibleRows: readonly WorkspaceTreeRow[];
  activeKey: string;
  overKey: string | null;
  code: string;
}): WorkspaceTreeDrop | null {
  const currentKey = input.overKey ?? input.activeKey;
  const index = input.visibleRows.findIndex((row) => row.workspace.workspaceKey === currentKey);
  const current = input.visibleRows[index];
  if (!current) return null;
  let target: WorkspaceTreeRow | undefined;
  let position: WorkspaceTreeDrop["position"];
  switch (input.code) {
    case "ArrowUp":
    case "ArrowDown": {
      const delta = input.code === "ArrowUp" ? -1 : 1;
      position = delta < 0 ? "before" : "after";
      for (let next = index + delta; next >= 0 && next < input.visibleRows.length; next += delta) {
        const candidate = input.visibleRows[next];
        const drop = projectWorkspaceTreeDrop({
          rows: input.rows,
          activeKey: input.activeKey,
          targetKey: candidate.workspace.workspaceKey,
          position,
        });
        if (drop) return drop;
      }
      return null;
    }
    case "ArrowRight":
      target = current;
      if (currentKey === input.activeKey) target = input.visibleRows[index - 1];
      position = "inside";
      break;
    case "ArrowLeft":
      target = input.rows.find((row) => row.workspace.workspaceKey === current.parentKey);
      position = "after";
      break;
    default:
      return null;
  }
  if (!target) return null;
  return projectWorkspaceTreeDrop({
    rows: input.rows,
    activeKey: input.activeKey,
    targetKey: target.workspace.workspaceKey,
    position,
  });
}
