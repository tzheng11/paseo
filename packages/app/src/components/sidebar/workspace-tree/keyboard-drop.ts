import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolveWorkspaceTreeDrop, type WorkspaceTreeDrop } from "./drop-target";
import { resolvePinnedWorkspaceTree, type PinnedWorkspaceSection } from "./pinned-layout";

interface WorkspaceKeyboardDropInput {
  code: string;
  workspaces: readonly SidebarWorkspacePlacement[];
  allWorkspaces?: readonly SidebarWorkspacePlacement[];
  workspaceKey: string;
  targetKeys: readonly string[];
  currentDrop: WorkspaceTreeDrop | null;
}
interface KeyboardDropContext {
  input: WorkspaceKeyboardDropInput;
  anchorKey: string;
  anchorIndex: number;
  parentKey: string | null;
  section: PinnedWorkspaceSection | undefined;
  parents: ReturnType<typeof resolvePinnedWorkspaceTree>;
  resolve: (key: string, position: WorkspaceTreeDrop["position"]) => WorkspaceTreeDrop | null;
}
export function resolveWorkspaceKeyboardDrop(
  input: WorkspaceKeyboardDropInput,
): WorkspaceTreeDrop | null {
  const source = input.workspaces.find(
    (workspace) => workspace.workspaceKey === input.workspaceKey,
  );
  if (!source) return null;
  const parents = resolvePinnedWorkspaceTree(input.workspaces);
  const anchorKey = input.currentDrop?.targetWorkspaceKey ?? input.workspaceKey;
  const context: KeyboardDropContext = {
    input,
    anchorKey,
    anchorIndex: input.targetKeys.indexOf(anchorKey),
    parents,
    parentKey: input.currentDrop
      ? (input.currentDrop.parentWorkspaceKey ?? null)
      : (parents.get(source.workspaceKey)?.parentWorkspaceKey ?? null),
    section: input.currentDrop?.pinSection ?? source.sidebarSection,
    resolve: (targetWorkspaceKey, position) =>
      resolveWorkspaceTreeDrop({ ...input, targetWorkspaceKey, position }),
  };
  switch (input.code) {
    case "ArrowUp":
      return moveVertically(context, -1);
    case "ArrowDown":
      return moveVertically(context, 1);
    case "ArrowRight":
      return nest(context);
    case "ArrowLeft":
      return context.parentKey && input.targetKeys.includes(context.parentKey)
        ? context.resolve(context.parentKey, "after")
        : null;
  }
  return null;
}
function sameParent(
  drop: WorkspaceTreeDrop | null,
  context: KeyboardDropContext,
): drop is WorkspaceTreeDrop {
  return (
    drop !== null &&
    (drop.parentWorkspaceKey ?? null) === context.parentKey &&
    drop.pinSection === context.section
  );
}
function moveVertically(context: KeyboardDropContext, direction: -1 | 1): WorkspaceTreeDrop | null {
  const { input, anchorKey, anchorIndex, resolve } = context;
  if (anchorIndex < 0) return null;
  const position = direction < 0 ? "before" : "after";
  const previousPosition = direction < 0 ? "after" : "before";
  if (input.currentDrop?.position === previousPosition) {
    const reversed = resolve(anchorKey, position);
    if (sameParent(reversed, context)) return reversed;
  }
  for (
    let index = anchorIndex + direction;
    index >= 0 && index < input.targetKeys.length;
    index += direction
  ) {
    const drop = resolve(input.targetKeys[index]!, position);
    if (sameParent(drop, context)) return drop;
  }
  return null;
}
function nest(context: KeyboardDropContext): WorkspaceTreeDrop | null {
  const { input, anchorKey, anchorIndex, parents, resolve } = context;
  if (input.currentDrop) return resolve(anchorKey, "inside");
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const key = input.targetKeys[index]!;
    const target = input.workspaces.find((workspace) => workspace.workspaceKey === key);
    if (
      !target ||
      target.sidebarSection !== context.section ||
      (parents.get(key)?.parentWorkspaceKey ?? null) !== context.parentKey
    )
      continue;
    const drop = resolve(key, "inside");
    if (drop) return drop;
  }
  return null;
}
