import {
  canonicalLayoutJson,
  resolveEffectiveWorkspaceLayout,
  workspaceLayoutParentKey,
  withWorkspaceSectionIntent,
  type EffectiveWorkspaceLayout,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutSnapshot,
  type WorkspaceNavigationPreferences,
} from "@getpaseo/protocol/workspace-layout";
import type { DaemonClient, FetchWorkspacesEntry } from "@getpaseo/client/internal/daemon-client";
import {
  collectPinnedWorkspaceSubtree,
  movePinnedWorkspaceTree,
  seedPinnedWorkspaceTree,
  type PinnedWorkspaceTreeItem,
  type PinnedWorkspaceSection,
} from "./pinned-layout";
import type { WorkspaceTreeDrop } from "./drop-target";
import { UNGROUPED_WORKSPACE_SORT_KEY } from "@getpaseo/protocol/sidebar-order";
import {
  captureUnmovedProjectOrders,
  reorderVisibleWorkspaceKeys,
} from "../../../utils/sidebar-reorder";

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
  projects?: Parameters<typeof captureUnmovedProjectOrders>[0]["projects"];
  now: string;
}
type DropOwnerClient = Pick<
  DaemonClient,
  "isConnected" | "getLastServerInfoMessage" | "getWorkspaceLayout" | "fetchWorkspaces"
>;
interface VerifiedDropInput extends CanonicalDropInput {
  ownerServerIds: readonly string[];
  getClient(serverId: string): DropOwnerClient | null;
}

/** Preflight the displayed CAS; a later observation must not rebase this drag onto a different graph. */
export async function verifyCanonicalWorkspaceDrop(input: VerifiedDropInput): Promise<string> {
  if (input.snapshot.stamp.phase !== "active")
    throw new Error("Shared layout import is not active.");
  const context = prepareDrop(input);
  canonicalWorkspaceDrop(input);
  const scope = canonicalDropScope(input, context);
  for (const owner of input.ownerServerIds)
    if (
      !(input.snapshot.semanticsVersion === 2
        ? input.snapshot.ownerDomains?.some((domain) => domain.serverId === owner)
        : input.snapshot.imports.some((source) => source.serverId === owner))
    )
      throw new Error(
        `Cannot verify subtree coverage for owner ${owner}: its hierarchy has not been adopted by the authority.`,
      );
  const origin = input.getClient(context.source.ref.serverId);
  if (!origin?.isConnected)
    throw new Error(`Affected hierarchy owner ${context.source.ref.serverId} is offline.`);
  const expectedMode = origin.getLastServerInfoMessage()?.workspaceLayout;
  const fresh = await origin.getWorkspaceLayout();
  if (canonicalLayoutJson(fresh) !== canonicalLayoutJson(input.snapshot))
    throw new Error("Shared layout changed. Refresh before moving the workspace.");
  for (const [owner, entries] of Map.groupBy(scope, (row) => row.ref.serverId)) {
    const client = input.getClient(owner);
    if (!client?.isConnected) throw new Error(`Affected hierarchy owner ${owner} is offline.`);
    if (client.getLastServerInfoMessage()?.serverId !== owner)
      throw new Error(`Affected owner ${owner} changed identity.`);
    assertDropAuthority(client, fresh, expectedMode?.authorityKeySha256);
    const rows = await readDropOwner(client);
    for (const entry of entries) {
      const row = rows.find((item) => item.id === entry.ref.workspaceId);
      if (
        !row ||
        !sameDropObservation(
          entry,
          row,
          context.effective?.get(`${entry.ref.serverId}:${entry.ref.workspaceId}`),
        )
      )
        throw new Error(
          `Affected workspace ${owner}:${entry.ref.workspaceId} differs from the current authority. Refresh before moving it.`,
        );
    }
  }
  return canonicalLayoutJson(input.snapshot.stamp);
}

function assertDropAuthority(
  client: DropOwnerClient,
  snapshot: WorkspaceLayoutSnapshot,
  expectedKey: string | undefined,
) {
  const mode = client.getLastServerInfoMessage()?.workspaceLayout;
  if (
    !mode?.synchronized ||
    !expectedKey ||
    mode.authorityServerId !== snapshot.stamp.authorityServerId ||
    mode.authorityId !== snapshot.stamp.authorityId ||
    mode.epoch !== snapshot.stamp.epoch ||
    mode.authorityKeySha256 !== expectedKey ||
    mode.stamp?.phase !== "active" ||
    mode.semanticsVersion !== snapshot.semanticsVersion ||
    (snapshot.semanticsVersion === 2 &&
      client.getLastServerInfoMessage()?.features?.workspaceLayoutDerivedSections !== true)
  )
    throw new Error("Affected owner is not synchronized with this active layout authority.");
}

function canonicalDropScope(
  input: CanonicalDropInput,
  context: DropContext,
): WorkspaceLayoutEntry[] {
  const subtree = collectPinnedWorkspaceSubtree({
    tree: context.tree,
    workspaces: context.workspaces,
    workspaceKey: input.drop.workspaceKey,
  });
  const changed = canonicalWorkspaceDrop(input).flatMap((mutation) =>
    mutation.kind === "put"
      ? [`${mutation.entry.ref.serverId}:${mutation.entry.ref.workspaceId}`]
      : [],
  );
  const keys = new Set([
    ...(input.snapshot.semanticsVersion === 2
      ? [input.drop.workspaceKey, ...changed]
      : subtree.workspaceKeys),
    input.drop.targetWorkspaceKey,
  ]);
  const oldParent = workspaceLayoutParentKey(context.source);
  if (input.snapshot.semanticsVersion === 2 && oldParent) keys.add(oldParent);
  const visited = new Set([input.drop.workspaceKey]);
  let parent = input.drop.parentWorkspaceKey ?? null;
  while (parent !== null) {
    if (visited.has(parent)) throw new Error("A workspace cannot be its own parent or ancestor.");
    visited.add(parent);
    const entry = context.byKey.get(parent);
    if (!entry || entry.archivedAt)
      throw new Error(`Required parent ancestry ${parent} is unavailable.`);
    keys.add(parent);
    parent = entry.pinPlacement
      ? entry.pinPlacement.parentWorkspaceKey
      : entry.parent && `${entry.parent.serverId}:${entry.parent.workspaceId}`;
  }
  return [...keys].map((key) => {
    const entry = context.byKey.get(key);
    if (!entry || entry.archivedAt) throw new Error(`Affected workspace ${key} is unavailable.`);
    return entry;
  });
}

async function readDropOwner(client: DropOwnerClient): Promise<FetchWorkspacesEntry[]> {
  const rows: FetchWorkspacesEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({
      includeBackground: true,
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    rows.push(...page.entries);
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || cursors.has(cursor))
      throw new Error("Affected workspace inventory is incomplete. Refresh before moving it.");
    cursors.add(cursor);
  } while (cursor);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Affected workspace inventory contains duplicate identities.");
  return rows;
}

function sameDropObservation(
  entry: WorkspaceLayoutEntry,
  row: FetchWorkspacesEntry,
  effective?: EffectiveWorkspaceLayout,
): boolean {
  return (
    entry.projectId === row.projectId &&
    (effective ? effective.pinnedAt : entry.pinnedAt) === row.pinnedAt &&
    (effective ? effective.superpinnedAt : entry.superpinnedAt) === row.superpinnedAt &&
    (entry.parent?.workspaceId ?? null) === (row.parentWorkspaceId ?? null) &&
    entry.siblingOrder === (row.siblingOrder ?? null) &&
    canonicalLayoutJson(entry.pinPlacement) === canonicalLayoutJson(row.pinPlacement ?? null)
  );
}
/** One CAS transaction for membership, parent links and cross-host visible order. No per-host effects. */
export function canonicalWorkspaceDrop(input: CanonicalDropInput): WorkspaceLayoutMutation[] {
  if (!input.snapshot.navigation) throw new Error("Shared navigation is not ready.");
  const context = prepareDrop(input);
  const changes = membershipChanges(input, context);
  const preferences = structuredClone(input.snapshot.navigation.preferences);
  if (input.drop.pinSection) {
    applyPinPlacements(input.drop, context, changes, input.snapshot.semanticsVersion === 2);
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
  const effective =
    snapshot.semanticsVersion === 2 ? resolveEffectiveWorkspaceLayout(snapshot) : null;
  const effectiveSection = (entry: WorkspaceLayoutEntry) =>
    effective?.get(`${entry.ref.serverId}:${entry.ref.workspaceId}`)?.section ?? section(entry);
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
    const unresolved = effective?.get(key)?.unresolvedParentKey;
    if (unresolved) throw new Error(`Required parent ancestry ${unresolved} is unavailable.`);
    if (!item || (item.sidebarSection ?? "unpinned") !== effectiveSection(entry))
      throw new Error("Workspace pin sections changed. Refresh before moving them.");
  }
  const tree = Object.fromEntries(
    snapshot.entries.flatMap((entry) =>
      entry.pinPlacement && !entry.archivedAt
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
      sidebarSection: effectiveSection(entry),
    }))
    .sort(
      (a, b) =>
        (order.get(a.workspaceKey) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.workspaceKey) ?? Number.MAX_SAFE_INTEGER),
    );
  return { byKey, source, catalog, tree, workspaces, effective };
}
type DropContext = ReturnType<typeof prepareDrop>;
function membershipChanges(
  input: CanonicalDropInput,
  context: DropContext,
): Map<string, WorkspaceLayoutEntry> {
  const { drop } = input;
  const { tree, workspaces, source, byKey } = context;
  if (input.snapshot.semanticsVersion === 2) return derivedMembershipChange(input, context);
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
function derivedMembershipChange(
  input: CanonicalDropInput,
  context: DropContext,
): Map<string, WorkspaceLayoutEntry> {
  const source = withWorkspaceSectionIntent({
    entry: context.source,
    effective: context.effective!.get(input.drop.workspaceKey)!,
    inherit: input.drop.pinSection !== undefined && input.drop.parentWorkspaceKey != null,
    section: input.drop.pinSection ?? "unpinned",
    now: input.now,
  });
  return new Map([[input.drop.workspaceKey, source]]);
}

function applyPinPlacements(
  drop: WorkspaceTreeDrop,
  context: DropContext,
  changes: Map<string, WorkspaceLayoutEntry>,
  derived: boolean,
): void {
  const { tree, workspaces, byKey } = context;
  const seeded = derived ? seedPinnedWorkspaceTree(tree, workspaces) : null;
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
      seeded &&
      key !== drop.workspaceKey &&
      canonicalLayoutJson(seeded[key]) === canonicalLayoutJson(placement)
    )
      continue;
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
  if (preferences.workspaceSort !== "manual") {
    if (!input.projects) throw new Error("Refresh project orders before changing the shared sort.");
    for (const update of captureUnmovedProjectOrders({
      projects: input.projects,
      movedProjectViewKey: view,
      workspaceOrderByProject: preferences.workspaceOrderByProject,
      workspaceSortModeByProject: preferences.workspaceSortModeByProject,
    }))
      preferences.workspaceOrderByProject[update.projectViewKey] = update.order;
  }
  if (drop.position === "inside") throw new Error("Pin workspaces before nesting them.");
  const ordered = reorderVisibleWorkspaceKeys({
    order: input.projectOrder,
    workspaceKey: drop.workspaceKey,
    targetWorkspaceKey: drop.targetWorkspaceKey,
    position: drop.position,
  });
  const stored = preferences.workspaceOrderByProject[view] ?? [];
  preferences.workspaceOrderByProject[view] = [
    ...ordered,
    ...stored.filter((key) => !ordered.includes(key)),
  ];
  preferences.workspaceSortModeByProject[view] = "manual";
  preferences.workspaceSort = "manual";
  changes.set(drop.workspaceKey, { ...(changes.get(drop.workspaceKey) ?? source), parent: null });
}
