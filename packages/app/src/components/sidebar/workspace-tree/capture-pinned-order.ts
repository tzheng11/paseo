import {
  seedPinnedWorkspaceTree,
  resolvePinnedWorkspaceTree,
  type PinnedWorkspaceSection,
  type PinnedWorkspaceTree,
  type PinnedWorkspaceTreeItem,
  type PinnedWorkspaceTreePlacement,
} from "./pinned-layout";

interface CaptureVisiblePinnedOrderInput {
  tree: PinnedWorkspaceTree;
  workspaces: readonly PinnedWorkspaceTreeItem[];
  visibleWorkspaces: readonly PinnedWorkspaceTreeItem[];
  section: PinnedWorkspaceSection;
}

export function captureVisiblePinnedOrder(
  input: CaptureVisiblePinnedOrderInput,
): Record<string, PinnedWorkspaceTreePlacement> {
  const seeded = seedPinnedWorkspaceTree(input.tree, input.workspaces);
  const resolved = resolvePinnedWorkspaceTree(input.workspaces, seeded);
  const byKey = new Map(input.workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const groups = new Map<string | null, string[]>();
  for (const workspace of input.workspaces) {
    if (workspace.sidebarSection !== input.section) continue;
    const parent = resolved.get(workspace.workspaceKey)!.parentWorkspaceKey;
    const siblings = groups.get(parent) ?? [];
    siblings.push(workspace.workspaceKey);
    groups.set(parent, siblings);
  }
  for (const siblings of groups.values()) {
    siblings.sort(
      (left, right) =>
        resolved.get(left)!.siblingOrder - resolved.get(right)!.siblingOrder ||
        left.localeCompare(right),
    );
  }

  const visibleGroups = new Map<string | null, string[]>();
  const seen = new Set<string>();
  for (const visible of input.visibleWorkspaces) {
    const workspace = byKey.get(visible.workspaceKey);
    if (
      !workspace ||
      workspace.sidebarSection !== input.section ||
      seen.has(workspace.workspaceKey)
    )
      continue;
    seen.add(workspace.workspaceKey);
    const parent = resolved.get(workspace.workspaceKey)!.parentWorkspaceKey;
    const siblings = visibleGroups.get(parent) ?? [];
    siblings.push(workspace.workspaceKey);
    visibleGroups.set(parent, siblings);
  }

  let next: Record<string, PinnedWorkspaceTreePlacement> | undefined;
  for (const [parent, visibleKeys] of visibleGroups) {
    const siblings = groups.get(parent)!;
    const visibleSet = new Set(visibleKeys);
    let index = 0;
    const captured = siblings.map((key) => (visibleSet.has(key) ? visibleKeys[index++]! : key));
    if (captured.every((key, siblingIndex) => key === siblings[siblingIndex])) continue;
    next ??= { ...seeded };
    for (const [siblingIndex, key] of captured.entries()) {
      const workspace = byKey.get(key)!;
      const saved = seeded[key];
      let parentWorkspaceKey = resolved.get(key)!.parentWorkspaceKey;
      if (saved) parentWorkspaceKey = saved.parentWorkspaceKey;
      else if (
        workspace.sidebarParentWorkspaceKey == null &&
        workspace.parentWorkspaceId &&
        !byKey.has(`${workspace.serverId}:${workspace.parentWorkspaceId}`)
      )
        // A projected null can mean the legacy parent has not hydrated yet.
        parentWorkspaceKey = `${workspace.serverId}:${workspace.parentWorkspaceId}`;
      else if (workspace.sidebarParentWorkspaceKey !== undefined)
        parentWorkspaceKey = workspace.sidebarParentWorkspaceKey;
      next[key] = { parentWorkspaceKey, siblingOrder: siblingIndex * 1024 };
    }
  }
  return next ?? seeded;
}
