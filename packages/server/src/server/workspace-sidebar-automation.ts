import type {
  WorkspaceSidebarPlacement,
  WorkspaceSidebarSection,
} from "./workspace-pin-placement.js";
import { workspaceSidebarSection } from "./workspace-pin-placement.js";
import {
  resolveEffectiveWorkspaceLayout,
  workspaceLayoutParentKey,
  withWorkspaceSectionIntent,
  type EffectiveWorkspaceLayout,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import { validateLayoutGraph } from "./workspace-layout-store.js";

export interface SidebarAutomationMove {
  workspaceKey: string;
  parentWorkspaceKey?: string | null;
  section?: WorkspaceSidebarSection;
  siblingOrder?: number;
  beforeWorkspaceKey?: string | null;
}

/** A fresh active authority proves the exact move dependencies without treating unknown owners as empty. */
export function planCanonicalSidebarMove(
  snapshot: WorkspaceLayoutSnapshot,
  input: SidebarAutomationMove,
  now: string,
) {
  if (snapshot.stamp.phase !== "active") throw new Error("Workspace layout import is not active.");
  validateLayoutGraph(snapshot);
  const entries = new Map(
    snapshot.entries.map((entry) => [`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry]),
  );
  const effective = resolveEffectiveWorkspaceLayout(snapshot);
  const rows = resolveSidebarAutomationCatalog(
    snapshot.entries
      .filter((entry) => !entry.archivedAt)
      .map((entry) =>
        canonicalSidebarWorkspace(
          entry,
          snapshot.semanticsVersion === 2
            ? effective.get(`${entry.ref.serverId}:${entry.ref.workspaceId}`)
            : undefined,
        ),
      ),
  );
  const source = rows.find((row) => row.workspaceKey === input.workspaceKey);
  if (!source)
    throw new Error(`Source workspace ${input.workspaceKey} is not active in the authority.`);
  const sourceView = effective.get(input.workspaceKey);
  if (snapshot.semanticsVersion === 2 && sourceView?.unresolvedParentKey)
    throw new Error(`Required source ancestry ${sourceView.unresolvedParentKey} is unavailable.`);
  const parentWorkspaceKey =
    input.parentWorkspaceKey === undefined
      ? workspaceLayoutParentKey(entries.get(source.workspaceKey)!)
      : input.parentWorkspaceKey;
  const sectionRows = rows.filter((row) => row.section === source.section);
  const subtree = sidebarAutomationSubtree(sectionRows, source.workspaceKey);
  const affected = collectCanonicalMoveAffected({
    snapshot,
    entries,
    source,
    subtree,
    parentWorkspaceKey,
    input,
  });
  const placement = resolveSidebarAutomationPlacement({
    ...input,
    workspaces: rows,
    movingWorkspaceKey: source.workspaceKey,
    parentWorkspaceKey,
    section: input.section ?? (parentWorkspaceKey === null ? source.section : undefined),
  });
  const moving =
    snapshot.semanticsVersion === 2 || placement.section === source.section ? [source] : subtree;
  const mutations = canonicalMoveMutations({
    snapshot,
    moving,
    entries,
    sourceKey: source.workspaceKey,
    placement,
    now,
    effective,
  });
  return { affected, mutations, placement };
}

interface CanonicalMoveScope {
  snapshot: WorkspaceLayoutSnapshot;
  entries: ReadonlyMap<string, WorkspaceLayoutEntry>;
  source: SidebarAutomationWorkspace;
  subtree: SidebarAutomationWorkspace[];
  parentWorkspaceKey: string | null;
  input: SidebarAutomationMove;
}
function collectCanonicalMoveAffected(context: CanonicalMoveScope): WorkspaceLayoutEntry[] {
  const { snapshot, entries, source, subtree, parentWorkspaceKey, input } = context;
  const affected = new Map<string, WorkspaceLayoutEntry>();
  for (const row of snapshot.semanticsVersion === 2 ? [source] : subtree)
    affected.set(row.workspaceKey, entries.get(row.workspaceKey)!);
  const oldParentKey = workspaceLayoutParentKey(entries.get(source.workspaceKey)!);
  if (snapshot.semanticsVersion === 2 && oldParentKey) {
    const oldParent = entries.get(oldParentKey);
    if (!oldParent || oldParent.archivedAt)
      throw new Error(`Required old parent ${oldParentKey} is unavailable.`);
    affected.set(oldParentKey, oldParent);
  }
  // Walk stored edges too: dormant links still participate in the authority's cycle checks.
  const visited = new Set([source.workspaceKey]);
  let ancestor = parentWorkspaceKey;
  while (ancestor !== null) {
    if (visited.has(ancestor)) throw new Error("A workspace cannot be its own parent or ancestor.");
    visited.add(ancestor);
    const entry = entries.get(ancestor);
    if (!entry || entry.archivedAt)
      throw new Error(`Required parent ancestry ${ancestor} is not active in the authority.`);
    affected.set(ancestor, entry);
    ancestor = entry.pinPlacement
      ? entry.pinPlacement.parentWorkspaceKey
      : entry.parent && `${entry.parent.serverId}:${entry.parent.workspaceId}`;
  }
  if (input.beforeWorkspaceKey) {
    const before = entries.get(input.beforeWorkspaceKey);
    if (!before) throw new Error(`Destination sibling ${input.beforeWorkspaceKey} is unknown.`);
    affected.set(input.beforeWorkspaceKey, before);
  }
  return [...affected.values()];
}
interface CanonicalMoveMutationInput {
  snapshot: WorkspaceLayoutSnapshot;
  moving: SidebarAutomationWorkspace[];
  entries: ReadonlyMap<string, WorkspaceLayoutEntry>;
  sourceKey: string;
  placement: WorkspaceSidebarPlacement & { siblingOrder: number };
  now: string;
  effective: ReadonlyMap<string, EffectiveWorkspaceLayout>;
}
function canonicalMoveMutations(input: CanonicalMoveMutationInput): WorkspaceLayoutMutation[] {
  const { snapshot, moving, entries, sourceKey, placement, now, effective } = input;
  return moving.map((row) => {
    const entry = entries.get(row.workspaceKey)!;
    const parent = row.workspaceKey === sourceKey ? placement : row.pinPlacement;
    let updated = entry;
    if (snapshot.semanticsVersion === 2)
      updated = withWorkspaceSectionIntent({
        entry,
        effective: effective.get(row.workspaceKey)!,
        inherit: placement.parentWorkspaceKey !== null,
        section: placement.section,
        now,
      });
    else
      updated = {
        ...entry,
        pinnedAt: placement.section === "unpinned" ? null : (row.pinnedAt ?? now),
        superpinnedAt: placement.section === "superpinned" ? (row.superpinnedAt ?? now) : null,
      };
    return {
      kind: "put",
      entry: {
        ...updated,
        pinPlacement: {
          parentWorkspaceKey: parent?.parentWorkspaceKey ?? null,
          siblingOrder: parent?.siblingOrder ?? 0,
          revision: (entry.pinPlacement?.revision ?? 0) + 1,
        },
      },
    };
  });
}

export function canonicalSidebarWorkspace(
  entry: WorkspaceLayoutEntry,
  effective?: EffectiveWorkspaceLayout,
): SidebarAutomationWorkspace {
  return {
    workspaceKey: `${entry.ref.serverId}:${entry.ref.workspaceId}`,
    workspaceId: entry.ref.workspaceId,
    projectId: entry.projectId,
    parentWorkspaceId: entry.parent?.workspaceId ?? null,
    siblingOrder: entry.siblingOrder ?? undefined,
    section: effective?.section ?? workspaceSidebarSection(entry),
    pinnedAt: effective ? effective.pinnedAt : entry.pinnedAt,
    superpinnedAt: effective ? effective.superpinnedAt : entry.superpinnedAt,
    pinPlacement: entry.pinPlacement ?? undefined,
  };
}

export interface SidebarAutomationWorkspace {
  workspaceKey: string;
  workspaceId: string;
  projectId?: string;
  parentWorkspaceId?: string | null;
  siblingOrder?: number;
  section: WorkspaceSidebarSection;
  pinnedAt?: string | null;
  superpinnedAt?: string | null;
  pinPlacement?: { parentWorkspaceKey: string | null; siblingOrder: number; revision: number };
}

/** Legacy hierarchy is project-scoped. Only real same-section children supply shared append ranks. */
export function resolveSidebarAutomationCatalog(
  workspaces: readonly SidebarAutomationWorkspace[],
): SidebarAutomationWorkspace[] {
  const byKey = new Map(workspaces.map((row) => [row.workspaceKey, row]));
  return workspaces.map((row) => {
    if (row.pinPlacement || !row.parentWorkspaceId) return row;
    const serverId = row.workspaceKey.slice(0, row.workspaceKey.indexOf(":"));
    const parentKey = `${serverId}:${row.parentWorkspaceId}`;
    const parent = byKey.get(parentKey);
    if (!parent || parent.projectId !== row.projectId || parent.section !== row.section) return row;
    return Object.assign({}, row, {
      pinPlacement: {
        parentWorkspaceKey: parentKey,
        siblingOrder: row.siblingOrder ?? 0,
        revision: 0,
      },
    });
  });
}

function validateSidebarAncestry(
  rows: ReadonlyMap<string, SidebarAutomationWorkspace>,
  parentKey: string | null,
  movingKey?: string,
) {
  const visited = new Set(movingKey ? [movingKey] : []);
  let ancestor = parentKey;
  while (ancestor !== null) {
    if (visited.has(ancestor)) throw new Error("A workspace cannot be its own parent or ancestor.");
    visited.add(ancestor);
    ancestor = rows.get(ancestor)?.pinPlacement?.parentWorkspaceKey ?? null;
  }
}

function resolveSiblingRank(
  siblings: readonly SidebarAutomationWorkspace[],
  order?: number,
  beforeKey?: string | null,
): number {
  if (beforeKey) {
    if (order !== undefined)
      throw new Error("Choose siblingOrder or beforeWorkspaceKey, not both.");
    const index = siblings.findIndex((row) => row.workspaceKey === beforeKey);
    if (index < 0)
      throw new Error("beforeWorkspaceKey must be a sibling in the destination section.");
    const next = siblings[index]!.pinPlacement?.siblingOrder ?? 0;
    const previous = index ? (siblings[index - 1]!.pinPlacement?.siblingOrder ?? 0) : next - 2048;
    order = previous + (next - previous) / 2;
    if (order === previous || order === next)
      throw new Error(
        "Sibling ranks are too close. Reorder these workspaces in Paseo before retrying.",
      );
  }
  order ??= Math.max(0, ...siblings.map((row) => row.pinPlacement?.siblingOrder ?? 0)) + 1024;
  if (!Number.isFinite(order)) throw new Error("Workspace order is out of range.");
  return order;
}

export function resolveSidebarAutomationPlacement(input: {
  workspaces: readonly SidebarAutomationWorkspace[];
  parentWorkspaceKey: string | null;
  section?: WorkspaceSidebarSection;
  siblingOrder?: number;
  beforeWorkspaceKey?: string | null;
  movingWorkspaceKey?: string;
}): WorkspaceSidebarPlacement & { siblingOrder: number } {
  const workspaces = resolveSidebarAutomationCatalog(input.workspaces);
  const rows = new Map(workspaces.map((row) => [row.workspaceKey, row]));
  const parent = input.parentWorkspaceKey === null ? undefined : rows.get(input.parentWorkspaceKey);
  if (
    input.parentWorkspaceKey !== null &&
    !parent &&
    (input.section === undefined || input.siblingOrder === undefined)
  )
    throw new Error(
      "Parent host is unavailable. Supply its saved section and siblingOrder, or connect that host before creating a child.",
    );
  const section = input.section ?? parent?.section ?? "unpinned";
  if (parent && input.section !== undefined && parent.section !== input.section)
    throw new Error("A child must use its parent workspace's section.");
  validateSidebarAncestry(rows, input.parentWorkspaceKey, input.movingWorkspaceKey);
  const siblings = workspaces
    .filter(
      (row) =>
        row.workspaceKey !== input.movingWorkspaceKey &&
        row.section === section &&
        (row.pinPlacement?.parentWorkspaceKey ?? null) === input.parentWorkspaceKey,
    )
    .sort(
      (a, b) =>
        (a.pinPlacement?.siblingOrder ?? 0) - (b.pinPlacement?.siblingOrder ?? 0) ||
        a.workspaceKey.localeCompare(b.workspaceKey),
    );
  return {
    parentWorkspaceKey: input.parentWorkspaceKey,
    siblingOrder: resolveSiblingRank(siblings, input.siblingOrder, input.beforeWorkspaceKey),
    section,
  };
}

export function sidebarAutomationSubtree(
  workspaces: readonly SidebarAutomationWorkspace[],
  rootKey: string,
): SidebarAutomationWorkspace[] {
  workspaces = resolveSidebarAutomationCatalog(workspaces);
  const keys = new Set([rootKey]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of workspaces) {
      if (
        !keys.has(row.workspaceKey) &&
        row.pinPlacement?.parentWorkspaceKey &&
        keys.has(row.pinPlacement.parentWorkspaceKey)
      ) {
        keys.add(row.workspaceKey);
        expanded = true;
      }
    }
  }
  return workspaces.filter((row) => keys.has(row.workspaceKey));
}
