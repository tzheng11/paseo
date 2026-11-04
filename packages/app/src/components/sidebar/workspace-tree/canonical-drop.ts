import {
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutSnapshot,
  type WorkspaceNavigationPreferences,
} from "@getpaseo/protocol/workspace-layout";
import {
  collectPinnedWorkspaceSubtree,
  movePinnedWorkspaceTree,
  type PinnedWorkspaceTreeItem,
  type PinnedWorkspaceSection,
} from "./pinned-layout";
import type { WorkspaceTreeDrop } from "./drop-target";
import { UNGROUPED_WORKSPACE_SORT_KEY } from "@getpaseo/protocol/sidebar-order";

interface CatalogItem {
  workspaceKey: string;
  projectViewKey?: string;
  sidebarSection?: PinnedWorkspaceSection;
}
function section(entry: WorkspaceLayoutEntry): PinnedWorkspaceSection {
  if (entry.superpinnedAt) return "superpinned";
  return entry.pinnedAt ? "pinned" : "unpinned";
}

interface CanonicalDropInput {
  snapshot: WorkspaceLayoutSnapshot;
  drop: WorkspaceTreeDrop;
  catalog: readonly CatalogItem[];
  projectOrder: readonly string[];
  now: string;
}
/** One CAS transaction for membership, parent links and cross-host visible order. No per-host effects. */
export function canonicalWorkspaceDrop(input: CanonicalDropInput): WorkspaceLayoutMutation[] {
  if (!input.snapshot.navigation) throw new Error("Shared navigation is not ready.");
  const context = prepareDrop(input);
  const changes = membershipChanges(input, context);
  const preferences = structuredClone(input.snapshot.navigation.preferences);
  if (input.drop.pinSection) {
    applyPinPlacements(input.drop, context, changes);
    if (input.drop.pinSection === "unpinned")
      preferences.workspaceSortModeByProject[UNGROUPED_WORKSPACE_SORT_KEY] = "manual";
    else preferences.pinnedWorkspaceSortMode = "manual";
  } else applyProjectOrder(input, context, changes, preferences);
  return [
    ...[...changes.values()].map((entry) => ({ kind: "put" as const, entry })),
    { kind: "put-navigation", expectedRevision: input.snapshot.navigation.revision, preferences },
  ];
}
function prepareDrop(input: CanonicalDropInput) {
  const { snapshot, drop } = input;
  const byKey = new Map(
    snapshot.entries.map((entry) => [`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry]),
  );
  const source = byKey.get(drop.workspaceKey),
    target = byKey.get(drop.targetWorkspaceKey);
  if (!source || !target || source.archivedAt || target.archivedAt)
    throw new Error("A workspace is no longer available.");
  const catalog = new Map(input.catalog.map((item) => [item.workspaceKey, item]));
  for (const key of [drop.workspaceKey, drop.targetWorkspaceKey]) {
    const item = catalog.get(key),
      entry = byKey.get(key)!;
    if (!item || (item.sidebarSection ?? "unpinned") !== section(entry))
      throw new Error("Workspace pin sections changed. Refresh before moving them.");
  }
  const tree = Object.fromEntries(
    snapshot.entries.flatMap((entry) =>
      entry.pinPlacement
        ? [[`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry.pinPlacement]]
        : [],
    ),
  );
  const order = new Map(input.catalog.map((item, index) => [item.workspaceKey, index]));
  const workspaces: PinnedWorkspaceTreeItem[] = snapshot.entries
    .filter((entry) => !entry.archivedAt)
    .map((entry) => ({
      workspaceKey: `${entry.ref.serverId}:${entry.ref.workspaceId}`,
      serverId: entry.ref.serverId,
      projectViewKey: JSON.stringify([entry.ref.serverId, entry.projectId]),
      parentWorkspaceId: entry.parent?.workspaceId ?? null,
      siblingOrder: entry.siblingOrder ?? undefined,
      sidebarSection: section(entry),
    }))
    .sort(
      (a, b) =>
        (order.get(a.workspaceKey) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.workspaceKey) ?? Number.MAX_SAFE_INTEGER),
    );
  return { byKey, source, catalog, tree, workspaces };
}
type DropContext = ReturnType<typeof prepareDrop>;
function membershipChanges(
  input: CanonicalDropInput,
  context: DropContext,
): Map<string, WorkspaceLayoutEntry> {
  const { drop } = input;
  const { tree, workspaces, source, byKey } = context;
  const subtree = collectPinnedWorkspaceSubtree({
    tree,
    workspaces,
    workspaceKey: drop.workspaceKey,
  });
  if (subtree.unavailableWorkspaceKeys.length)
    throw new Error("The complete workspace group could not be verified.");
  const destination = drop.pinSection ?? "unpinned";
  const moving = section(source) === destination ? [drop.workspaceKey] : subtree.workspaceKeys;
  const changes = new Map<string, WorkspaceLayoutEntry>();
  for (const key of moving) {
    const entry = byKey.get(key)!;
    changes.set(key, {
      ...entry,
      pinnedAt: destination === "unpinned" ? null : (entry.pinnedAt ?? input.now),
      superpinnedAt: destination === "superpinned" ? (entry.superpinnedAt ?? input.now) : null,
    });
  }
  return changes;
}
function applyPinPlacements(
  drop: WorkspaceTreeDrop,
  context: DropContext,
  changes: Map<string, WorkspaceLayoutEntry>,
): void {
  const { tree, workspaces, byKey } = context;
  const moved = movePinnedWorkspaceTree({
    tree,
    workspaces,
    workspaceKey: drop.workspaceKey,
    parentWorkspaceKey: drop.parentWorkspaceKey ?? null,
    beforeWorkspaceKey: drop.beforeWorkspaceKey ?? null,
    section: drop.pinSection!,
  });
  if (!moved.ok) throw new Error(moved.reason);
  for (const [key, placement] of Object.entries(moved.tree)) {
    const old = byKey.get(key);
    if (!old || old.archivedAt) continue;
    if (
      old.pinPlacement?.parentWorkspaceKey === placement.parentWorkspaceKey &&
      old.pinPlacement.siblingOrder === placement.siblingOrder
    )
      continue;
    changes.set(key, {
      ...(changes.get(key) ?? old),
      pinPlacement: { ...placement, revision: (old.pinPlacement?.revision ?? 0) + 1 },
    });
  }
}
function applyProjectOrder(
  input: CanonicalDropInput,
  context: DropContext,
  changes: Map<string, WorkspaceLayoutEntry>,
  preferences: WorkspaceNavigationPreferences,
): void {
  const { drop } = input;
  const { catalog, source } = context;
  const view = catalog.get(drop.workspaceKey)!.projectViewKey;
  if (!view || view !== catalog.get(drop.targetWorkspaceKey)!.projectViewKey)
    throw new Error("Reorder within the same project view.");
  const ordered = input.projectOrder.filter((key) => key !== drop.workspaceKey);
  const index = ordered.indexOf(drop.targetWorkspaceKey);
  if (index < 0) throw new Error("Destination workspace is not in the current project view.");
  ordered.splice(index + Number(drop.position === "after"), 0, drop.workspaceKey);
  const stored = preferences.workspaceOrderByProject[view] ?? [];
  preferences.workspaceOrderByProject[view] = [
    ...ordered,
    ...stored.filter((key) => !ordered.includes(key)),
  ];
  preferences.workspaceSortModeByProject[view] = "manual";
  preferences.workspaceSort = "manual";
  changes.set(drop.workspaceKey, { ...(changes.get(drop.workspaceKey) ?? source), parent: null });
}
