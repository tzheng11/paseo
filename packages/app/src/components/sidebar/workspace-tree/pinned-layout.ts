export type PinnedWorkspaceSection = "pinned" | "superpinned";
export interface PinnedWorkspaceTreePlacement {
  parentWorkspaceKey: string | null;
  siblingOrder: number;
}
export type PinnedWorkspaceTree = Readonly<Record<string, PinnedWorkspaceTreePlacement>>;
export interface PinnedWorkspaceTreeItem {
  workspaceKey: string;
  serverId: string;
  projectViewKey?: string;
  parentWorkspaceId?: string | null;
  sidebarParentWorkspaceKey?: string | null;
  sidebarSection?: PinnedWorkspaceSection;
  siblingOrder?: number;
}

const STEP = 1024;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function candidateParent(
  workspace: PinnedWorkspaceTreeItem,
  tree: PinnedWorkspaceTree,
  byKey: ReadonlyMap<string, PinnedWorkspaceTreeItem>,
): string | null {
  if (!workspace.sidebarSection) return null;
  if (own(tree, workspace.workspaceKey)) return tree[workspace.workspaceKey]!.parentWorkspaceKey;
  if (workspace.sidebarParentWorkspaceKey !== undefined) return workspace.sidebarParentWorkspaceKey;
  if (!workspace.parentWorkspaceId) return null;
  const key = `${workspace.serverId}:${workspace.parentWorkspaceId}`;
  const parent = byKey.get(key);
  return parent?.serverId === workspace.serverId &&
    parent.projectViewKey === workspace.projectViewKey &&
    parent.sidebarSection === workspace.sidebarSection
    ? key
    : null;
}

function groupKey(section: PinnedWorkspaceSection, parent: string | null): string {
  return JSON.stringify([section, parent]);
}

function breakParentCycles(parents: Map<string, string | null>): void {
  // Break every edge participating in a cycle, deterministically. Descendants
  // remain attached to a visible cycle member; no corrupt graph can hide rows.
  const visited = new Set<string>();
  for (const key of parents.keys()) {
    const path: string[] = [];
    const offsets = new Map<string, number>();
    let next: string | null = key;
    while (next !== null && !visited.has(next) && !offsets.has(next)) {
      offsets.set(next, path.length);
      path.push(next);
      next = parents.get(next) ?? null;
    }
    if (next !== null && offsets.has(next)) {
      for (const member of path.slice(offsets.get(next)!)) parents.set(member, null);
    }
    for (const member of path) visited.add(member);
  }
}

function savedRank(
  workspace: PinnedWorkspaceTreeItem,
  tree: PinnedWorkspaceTree,
): number | undefined {
  const saved = tree[workspace.workspaceKey]?.siblingOrder;
  if (finite(saved)) return saved;
  if (workspace.sidebarParentWorkspaceKey !== undefined && finite(workspace.siblingOrder))
    return workspace.siblingOrder;
  return undefined;
}

function compareSiblingRanks(
  left: PinnedWorkspaceTreeItem,
  right: PinnedWorkspaceTreeItem,
  tree: PinnedWorkspaceTree,
  parents: ReadonlyMap<string, string | null>,
  indices: ReadonlyMap<string, number>,
): number {
  const l = savedRank(left, tree),
    r = savedRank(right, tree);
  if (l !== undefined || r !== undefined) {
    if (l === undefined) return 1;
    if (r === undefined) return -1;
    return l - r || left.workspaceKey.localeCompare(right.workspaceKey);
  }
  // Legacy backend ranks are scoped to siblings, never compared between
  // projects/hosts at the section root. Root arrays/recency define fallback.
  if (parents.get(left.workspaceKey) !== null) {
    const lLegacy = finite(left.siblingOrder),
      rLegacy = finite(right.siblingOrder);
    if (lLegacy !== rLegacy) return lLegacy ? -1 : 1;
    if (lLegacy && rLegacy)
      return (
        left.siblingOrder! - right.siblingOrder! ||
        left.workspaceKey.localeCompare(right.workspaceKey)
      );
  }
  return indices.get(left.workspaceKey)! - indices.get(right.workspaceKey)!;
}

function siblingRanks(
  siblings: readonly PinnedWorkspaceTreeItem[],
  tree: PinnedWorkspaceTree,
): number[] {
  let last: number | undefined;
  let normalize = false;
  const ranks: number[] = [];
  for (const workspace of siblings) {
    const saved = savedRank(workspace, tree);
    const value = saved ?? (last === undefined ? 0 : last + STEP);
    if (!finite(value) || (saved === undefined && last !== undefined && value <= last))
      normalize = true;
    ranks.push(value);
    last = value;
  }
  return normalize ? siblings.map((_, index) => index * STEP) : ranks;
}

/** The caller supplies explicit pin membership, never a filtered/pruned saved tree. */
export function resolvePinnedWorkspaceTree(
  workspaces: readonly PinnedWorkspaceTreeItem[],
  tree: PinnedWorkspaceTree = {},
): ReadonlyMap<string, PinnedWorkspaceTreePlacement> {
  const byKey = new Map(workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const parents = new Map<string, string | null>();
  for (const workspace of workspaces) {
    if (!workspace.sidebarSection) continue;
    const parent = candidateParent(workspace, tree, byKey);
    parents.set(
      workspace.workspaceKey,
      parent !== null &&
        parent !== workspace.workspaceKey &&
        byKey.get(parent)?.sidebarSection === workspace.sidebarSection
        ? parent
        : null,
    );
  }
  breakParentCycles(parents);
  const groups = new Map<string, PinnedWorkspaceTreeItem[]>();
  const indices = new Map(workspaces.map((workspace, index) => [workspace.workspaceKey, index]));
  for (const workspace of workspaces) {
    if (!workspace.sidebarSection) continue;
    const key = groupKey(workspace.sidebarSection, parents.get(workspace.workspaceKey) ?? null);
    const siblings = groups.get(key) ?? [];
    siblings.push(workspace);
    groups.set(key, siblings);
  }
  const result = new Map<string, PinnedWorkspaceTreePlacement>();
  for (const siblings of groups.values()) {
    siblings.sort((left, right) => compareSiblingRanks(left, right, tree, parents, indices));
    const ranks = siblingRanks(siblings, tree);
    siblings.forEach((workspace, index) =>
      result.set(workspace.workspaceKey, {
        parentWorkspaceKey: parents.get(workspace.workspaceKey) ?? null,
        siblingOrder: ranks[index]!,
      }),
    );
  }
  return result;
}

/** Lazily import a complete pin catalog without overwriting local or dormant preferences. */
export function seedPinnedWorkspaceTree(
  tree: PinnedWorkspaceTree,
  orderedWorkspaces: readonly PinnedWorkspaceTreeItem[],
): Record<string, PinnedWorkspaceTreePlacement> {
  let next: Record<string, PinnedWorkspaceTreePlacement> | undefined;
  const resolved = resolvePinnedWorkspaceTree(orderedWorkspaces, tree);
  const byKey = new Map(orderedWorkspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const deferredGroups = new Set<string>();
  for (const workspace of orderedWorkspaces) {
    const placement = resolved.get(workspace.workspaceKey);
    const saved = tree[workspace.workspaceKey];
    if (
      workspace.sidebarSection &&
      placement &&
      saved &&
      placement.siblingOrder !== saved.siblingOrder
    )
      deferredGroups.add(groupKey(workspace.sidebarSection, placement.parentWorkspaceKey));
  }
  for (const workspace of orderedWorkspaces) {
    if (!workspace.sidebarSection || own(next ?? tree, workspace.workspaceKey)) continue;
    // A partially hydrated/offline catalog cannot prove a legacy parent absent.
    // Defer its import rather than persist null and lose that edge forever.
    if (
      typeof workspace.sidebarParentWorkspaceKey !== "string" &&
      workspace.parentWorkspaceId &&
      !byKey.has(`${workspace.serverId}:${workspace.parentWorkspaceId}`)
    )
      continue;
    const placement = resolved.get(workspace.workspaceKey)!;
    // Overflow can require a view-only normalization. Do not mix those ranks
    // into saved extreme ranks; the next actual move rebalances that group.
    if (deferredGroups.has(groupKey(workspace.sidebarSection, placement.parentWorkspaceKey)))
      continue;
    next ??= { ...tree };
    next[workspace.workspaceKey] = { ...placement };
  }
  return next ?? (tree as Record<string, PinnedWorkspaceTreePlacement>);
}

export interface MovePinnedWorkspaceTreeInput {
  tree: PinnedWorkspaceTree;
  /** Full, unfiltered catalog, with original confirmed section membership. */
  workspaces: readonly PinnedWorkspaceTreeItem[];
  workspaceKey: string;
  parentWorkspaceKey: string | null;
  beforeWorkspaceKey: string | null;
  section: PinnedWorkspaceSection;
}
export type MovePinnedWorkspaceTreeResult =
  | {
      ok: true;
      tree: Record<string, PinnedWorkspaceTreePlacement>;
      siblingOrder: number;
      rebalanced: boolean;
    }
  | { ok: false; reason: string };

function createsRawCycle(
  input: MovePinnedWorkspaceTreeInput,
  byKey: ReadonlyMap<string, PinnedWorkspaceTreeItem>,
): boolean {
  // Dormant/offline saved edges must not allow a cycle after reconnecting.
  let ancestor = input.parentWorkspaceKey;
  const seen = new Set<string>();
  while (ancestor !== null) {
    if (ancestor === input.workspaceKey || seen.has(ancestor)) return true;
    seen.add(ancestor);
    const workspace = byKey.get(ancestor);
    if (own(input.tree, ancestor)) ancestor = input.tree[ancestor]!.parentWorkspaceKey;
    else if (workspace) ancestor = candidateParent(workspace, input.tree, byKey);
    else ancestor = null;
  }
  return false;
}

function insertedRank(previous: number | undefined, following: number | undefined): number {
  if (previous === undefined && following === undefined) return 0;
  if (previous === undefined) return following! - STEP;
  if (following === undefined) return previous + STEP;
  return previous / 2 + following / 2;
}

function needsRebalance(
  order: number,
  previous: number | undefined,
  following: number | undefined,
  siblings: readonly PinnedWorkspaceTreeItem[],
  tree: PinnedWorkspaceTree,
): boolean {
  return (
    !finite(order) ||
    (previous !== undefined && order <= previous) ||
    (following !== undefined && order >= following) ||
    siblings.some((workspace) => !finite(tree[workspace.workspaceKey]?.siblingOrder))
  );
}

function parentToPreserve(
  key: string,
  tree: PinnedWorkspaceTree,
  byKey: ReadonlyMap<string, PinnedWorkspaceTreeItem>,
  resolved: ReadonlyMap<string, PinnedWorkspaceTreePlacement>,
): string | null {
  if (own(tree, key)) return tree[key]!.parentWorkspaceKey;
  const workspace = byKey.get(key);
  if (typeof workspace?.sidebarParentWorkspaceKey === "string")
    return workspace.sidebarParentWorkspaceKey;
  if (
    workspace?.parentWorkspaceId &&
    !byKey.has(`${workspace.serverId}:${workspace.parentWorkspaceId}`)
  )
    return `${workspace.serverId}:${workspace.parentWorkspaceId}`;
  if (workspace?.sidebarParentWorkspaceKey !== undefined)
    return workspace.sidebarParentWorkspaceKey;
  return resolved.get(key)!.parentWorkspaceKey;
}

/** Call after any single-workspace pin-membership mutation has been confirmed. */
export function movePinnedWorkspaceTree(
  input: MovePinnedWorkspaceTreeInput,
): MovePinnedWorkspaceTreeResult {
  const byKey = new Map(input.workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const source = byKey.get(input.workspaceKey);
  if (!source) return { ok: false, reason: "Workspace is no longer available" };
  const beforeMove = resolvePinnedWorkspaceTree(input.workspaces, input.tree);
  if (
    source.sidebarSection !== input.section &&
    [...beforeMove.values()].some(
      (placement) => placement.parentWorkspaceKey === source.workspaceKey,
    )
  )
    return {
      ok: false,
      reason: "Move children out before moving a group between pinned sections",
    };
  if (
    input.parentWorkspaceKey !== null &&
    byKey.get(input.parentWorkspaceKey)?.sidebarSection !== input.section
  )
    return { ok: false, reason: "Parent is no longer in this pinned section" };
  if (createsRawCycle(input, byKey))
    return { ok: false, reason: "A workspace cannot be moved into one of its children" };
  const destination = input.workspaces.map((workspace) =>
    workspace.workspaceKey === source.workspaceKey
      ? { ...workspace, sidebarSection: input.section }
      : workspace,
  );
  const next = { ...seedPinnedWorkspaceTree(input.tree, input.workspaces) };
  const resolved = resolvePinnedWorkspaceTree(destination, next);
  const siblings = destination
    .filter(
      (workspace) =>
        workspace.workspaceKey !== source.workspaceKey &&
        workspace.sidebarSection === input.section &&
        resolved.get(workspace.workspaceKey)?.parentWorkspaceKey === input.parentWorkspaceKey,
    )
    .sort(
      (left, right) =>
        resolved.get(left.workspaceKey)!.siblingOrder -
          resolved.get(right.workspaceKey)!.siblingOrder ||
        left.workspaceKey.localeCompare(right.workspaceKey),
    );
  let index = siblings.length;
  if (input.beforeWorkspaceKey !== null) {
    index = siblings.findIndex((workspace) => workspace.workspaceKey === input.beforeWorkspaceKey);
    if (index < 0) return { ok: false, reason: "Sibling is no longer in this pinned group" };
  }
  const previous = index > 0 ? next[siblings[index - 1]!.workspaceKey]?.siblingOrder : undefined;
  const following =
    index < siblings.length ? next[siblings[index]!.workspaceKey]?.siblingOrder : undefined;
  let order = insertedRank(previous, following);
  const rebalanced = needsRebalance(order, previous, following, siblings, next);
  if (rebalanced) {
    const orderedKeys = siblings.map((workspace) => workspace.workspaceKey);
    orderedKeys.splice(index, 0, source.workspaceKey);
    orderedKeys.forEach((key, siblingIndex) => {
      next[key] = {
        parentWorkspaceKey:
          key === source.workspaceKey
            ? input.parentWorkspaceKey
            : parentToPreserve(key, next, byKey, resolved),
        siblingOrder: siblingIndex * STEP,
      };
    });
    order = index * STEP;
  } else
    next[source.workspaceKey] = {
      parentWorkspaceKey: input.parentWorkspaceKey,
      siblingOrder: order,
    };
  return { ok: true, tree: next, siblingOrder: order, rebalanced };
}
