import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

const ORDER_SPACING = 1024;

export interface WorkspaceMoveInput {
  workspaceId: string;
  parentWorkspaceId: string | null;
  beforeWorkspaceId?: string | null;
}

function siblings(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  workspace: PersistedWorkspaceRecord,
  parentWorkspaceId: string | null,
): PersistedWorkspaceRecord[] {
  return [...records.values()]
    .filter(
      (candidate) =>
        !candidate.archivedAt &&
        candidate.workspaceId !== workspace.workspaceId &&
        candidate.projectId === workspace.projectId &&
        (candidate.parentWorkspaceId ?? null) === parentWorkspaceId,
    )
    .sort(
      (left, right) =>
        (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0) ||
        left.workspaceId.localeCompare(right.workspaceId),
    );
}

function validateParent(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  workspace: PersistedWorkspaceRecord,
  parentWorkspaceId: string | null,
): void {
  if (parentWorkspaceId === null) return;
  const seen = new Set([workspace.workspaceId]);
  let cursor: string | null = parentWorkspaceId;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error("Workspace hierarchy cannot contain a cycle");
    seen.add(cursor);
    const ancestor = records.get(cursor);
    if (!ancestor || ancestor.archivedAt)
      throw new Error("Active parent workspace not found on this host");
    if (ancestor.projectId !== workspace.projectId)
      throw new Error("Parent workspace must belong to the same project");
    cursor = ancestor.parentWorkspaceId ?? null;
  }
}

function rankAt(entries: readonly PersistedWorkspaceRecord[], index: number): number {
  const previous = entries[index - 1]?.siblingOrder;
  const next = entries[index]?.siblingOrder;
  if (previous === undefined) return next === undefined ? ORDER_SPACING : next - ORDER_SPACING;
  if (next === undefined) return previous + ORDER_SPACING;
  return previous + (next - previous) / 2;
}

/** Called only inside the registry's serialized commit. */
export function moveWorkspaceInHierarchy(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  input: WorkspaceMoveInput,
): PersistedWorkspaceRecord[] {
  const workspace = records.get(input.workspaceId);
  if (!workspace || workspace.archivedAt) throw new Error("Active workspace not found");
  validateParent(records, workspace, input.parentWorkspaceId);
  if (input.beforeWorkspaceId === input.workspaceId) {
    if ((workspace.parentWorkspaceId ?? null) !== input.parentWorkspaceId)
      throw new Error("Insertion target must be a destination sibling");
    return [workspace];
  }
  let entries = siblings(records, workspace, input.parentWorkspaceId);
  const index =
    input.beforeWorkspaceId == null
      ? entries.length
      : entries.findIndex((entry) => entry.workspaceId === input.beforeWorkspaceId);
  if (index < 0) throw new Error("Insertion target must be an active destination sibling");
  let order = rankAt(entries, index);
  const previous = entries[index - 1]?.siblingOrder;
  const next = entries[index]?.siblingOrder;
  const hasDuplicateRanks = entries.some(
    (entry, i) => i > 0 && entry.siblingOrder === entries[i - 1]?.siblingOrder,
  );
  const changed: PersistedWorkspaceRecord[] = [];
  const updatedAt = new Date().toISOString();
  if (
    hasDuplicateRanks ||
    !Number.isFinite(order) ||
    (previous !== undefined && order <= previous) ||
    (next !== undefined && order >= next)
  ) {
    entries = entries.map((entry, i) => ({
      ...entry,
      siblingOrder: (i + 1) * ORDER_SPACING,
      updatedAt,
    }));
    changed.push(...entries);
    order = rankAt(entries, index);
  }
  changed.push({
    ...workspace,
    parentWorkspaceId: input.parentWorkspaceId,
    siblingOrder: order,
    updatedAt,
  });
  return changed;
}

export function appendWorkspaceToHierarchy(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  workspace: PersistedWorkspaceRecord,
): PersistedWorkspaceRecord[] {
  const staged = new Map(records);
  staged.set(workspace.workspaceId, { ...workspace, archivedAt: null });
  return moveWorkspaceInHierarchy(staged, {
    workspaceId: workspace.workspaceId,
    parentWorkspaceId: workspace.parentWorkspaceId ?? null,
  }).map((entry) =>
    entry.workspaceId === workspace.workspaceId
      ? Object.assign({}, entry, {
          archivedAt: workspace.archivedAt,
          updatedAt: workspace.updatedAt,
        })
      : entry,
  );
}

export function promoteWorkspaceChildren(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  workspace: PersistedWorkspaceRecord,
  updatedAt: string,
): PersistedWorkspaceRecord[] {
  const parent = workspace.parentWorkspaceId ? records.get(workspace.parentWorkspaceId) : null;
  const destination =
    parent && !parent.archivedAt && parent.projectId === workspace.projectId
      ? parent.workspaceId
      : null;
  const staged = new Map(records);
  const changed = new Map<string, PersistedWorkspaceRecord>();
  const children = siblings(records, { ...workspace, workspaceId: "" }, workspace.workspaceId);
  for (const child of children) {
    for (const next of moveWorkspaceInHierarchy(staged, {
      workspaceId: child.workspaceId,
      parentWorkspaceId: destination,
    })) {
      const promoted = { ...next, updatedAt };
      staged.set(promoted.workspaceId, promoted);
      changed.set(promoted.workspaceId, promoted);
    }
  }
  return [...changed.values()];
}

/** Missing fields on pre-hierarchy records become deterministic root order, with no migration. */
export function normalizeLegacyWorkspaceHierarchy(
  records: Map<string, PersistedWorkspaceRecord>,
): void {
  const ordered = [...records.values()].sort((left, right) =>
    left.workspaceId.localeCompare(right.workspaceId),
  );
  for (const workspace of ordered) {
    if (workspace.parentWorkspaceId !== undefined && workspace.siblingOrder !== undefined) continue;
    const parentWorkspaceId = workspace.parentWorkspaceId ?? null;
    const peers = siblings(records, workspace, parentWorkspaceId);
    const maximum = Math.max(0, ...peers.map((peer) => peer.siblingOrder ?? 0));
    records.set(workspace.workspaceId, {
      ...workspace,
      parentWorkspaceId,
      siblingOrder: workspace.siblingOrder ?? maximum + ORDER_SPACING,
    });
  }
}
