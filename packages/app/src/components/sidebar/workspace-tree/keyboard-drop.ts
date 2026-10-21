import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { effectiveParentId, resolveWorkspaceTreeDrop, type WorkspaceTreeDrop } from "./drop-target";

interface WorkspaceKeyboardDropInput {
  code: string;
  workspaces: readonly SidebarWorkspacePlacement[];
  workspaceKey: string;
  targetKeys: readonly string[];
  currentDrop: WorkspaceTreeDrop | null;
  pinnedRootKeys?: ReadonlySet<string>;
}

interface KeyboardDropContext {
  input: WorkspaceKeyboardDropInput;
  source: SidebarWorkspacePlacement;
  anchorKey: string;
  anchorIndex: number;
  parentId: string | null;
  resolve: (key: string, position: WorkspaceTreeDrop["position"]) => WorkspaceTreeDrop | null;
}

export function resolveWorkspaceKeyboardDrop(
  input: WorkspaceKeyboardDropInput,
): WorkspaceTreeDrop | null {
  const resolve = (targetWorkspaceKey: string, position: WorkspaceTreeDrop["position"]) =>
    resolveWorkspaceTreeDrop({ ...input, targetWorkspaceKey, position });
  const source = input.workspaces.find(
    (workspace) => workspace.workspaceKey === input.workspaceKey,
  );
  if (!source) return null;
  const anchorKey = input.currentDrop?.targetWorkspaceKey ?? input.workspaceKey;
  const anchorIndex = input.targetKeys.indexOf(anchorKey);
  const parentId = input.currentDrop
    ? input.currentDrop.parentWorkspaceId
    : effectiveParentId(input.workspaces, source);
  const context = { input, source, anchorKey, anchorIndex, parentId, resolve };
  switch (input.code) {
    case "ArrowUp":
      return moveVertically(context, -1);
    case "ArrowDown":
      return moveVertically(context, 1);
    case "ArrowRight":
      return nest(context);
    case "ArrowLeft": {
      const parentKey = parentId === null ? null : `${source.serverId}:${parentId}`;
      return parentKey && input.targetKeys.includes(parentKey) ? resolve(parentKey, "after") : null;
    }
  }
  return null;
}

function sameParent(
  drop: WorkspaceTreeDrop | null,
  parentId: string | null,
): drop is WorkspaceTreeDrop {
  return drop !== null && (drop.pinnedOrderOnly === true || drop.parentWorkspaceId === parentId);
}

function moveVertically(context: KeyboardDropContext, direction: -1 | 1): WorkspaceTreeDrop | null {
  const { input, anchorKey, anchorIndex, parentId, resolve } = context;
  if (anchorIndex < 0) return null;
  const position = direction < 0 ? "before" : "after";
  const previousPosition = direction < 0 ? "after" : "before";
  if (input.currentDrop?.position === previousPosition) {
    const reversed = resolve(anchorKey, position);
    if (sameParent(reversed, parentId)) return reversed;
  }
  for (
    let index = anchorIndex + direction;
    index >= 0 && index < input.targetKeys.length;
    index += direction
  ) {
    const drop = resolve(input.targetKeys[index]!, position);
    if (sameParent(drop, parentId)) return drop;
  }
  return null;
}

function nest(context: KeyboardDropContext): WorkspaceTreeDrop | null {
  const { input, anchorKey, anchorIndex, parentId, resolve } = context;
  if (input.currentDrop) return resolve(anchorKey, "inside");
  // Indenting in place uses the preceding sibling, including when that sibling
  // has an expanded subtree between its row and the active row.
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const key = input.targetKeys[index]!;
    const target = input.workspaces.find((workspace) => workspace.workspaceKey === key);
    if (!target || effectiveParentId(input.workspaces, target) !== parentId) continue;
    const drop = resolve(key, "inside");
    if (drop) return drop;
  }
  return null;
}
