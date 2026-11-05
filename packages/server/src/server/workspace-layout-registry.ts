import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import {
  workspaceReferenceKey,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import {
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  type PersistedWorkspaceRecord,
  type WorkspaceMutationContext,
  type WorkspaceMoveInput,
} from "./workspace-registry.js";
import type { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { WorkspaceLayoutRefusal } from "./workspace-layout-store.js";

const LAYOUT_FIELDS = [
  "projectId",
  "pinnedAt",
  "superpinnedAt",
  "parentWorkspaceId",
  "siblingOrder",
  "pinPlacement",
  "archivedAt",
] as const;

/** Execution records stay local; every mutable layout field belongs to the configured authority. */
export class CanonicalWorkspaceRegistry extends FileBackedWorkspaceRegistry {
  readonly destructiveRetirement = "refuse" as const;
  private queue: Promise<unknown> = Promise.resolve();
  private projection: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(
    file: string,
    logger: Logger,
    private readonly layout: WorkspaceLayoutService,
    private readonly serverId: string,
  ) {
    super(file, logger);
    this.unsubscribe = layout.subscribe(() => {
      this.projection = this.projection
        .then(() => this.syncProtectionProjection())
        .catch((error) => {
          logger.error({ err: error }, "Canonical workspace protection projection failed");
          throw error;
        });
      // Retain the failure for close/inspection without an unhandled rejection.
      void this.projection.catch(() => {});
    });
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    await this.syncProtectionProjection();
  }

  override async list(): Promise<PersistedWorkspaceRecord[]> {
    return (await super.list()).flatMap((record) => {
      const projected = this.projectOrQuarantine(record);
      return projected ? [projected] : [];
    });
  }
  override async get(id: string): Promise<PersistedWorkspaceRecord | null> {
    const record = await super.get(id);
    return record ? this.project(record) : null;
  }

  async assertLayoutWriteAllowed(): Promise<void> {
    await this.freshActive();
  }

  override update(
    id: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<PersistedWorkspaceRecord | null> {
    return this.serial(async (requestId) => {
      const raw = await super.get(id);
      if (!raw) return null;
      const snapshot = context?.layoutWrite ? await this.freshActive() : undefined;
      const current = this.project(raw, snapshot);
      let next = updater(structuredClone(current));
      let changed = changedFields(current, next);
      let layoutChanged = LAYOUT_FIELDS.filter((field) => Object.hasOwn(changed, field));
      let projected = current;
      if (layoutChanged.length) {
        const active = snapshot ?? (await this.freshActive());
        const fresh = this.project(raw, active);
        // Re-run pure updater guards (notably expected placement revision) on
        // the authority value, rather than accepting a stale replica's check.
        next = snapshot ? next : updater(structuredClone(fresh));
        changed = changedFields(fresh, next);
        layoutChanged = LAYOUT_FIELDS.filter((field) => Object.hasOwn(changed, field));
        const intent = Object.fromEntries(layoutChanged.map((field) => [field, next[field]]));
        projected = Object.assign({}, fresh, intent);
        if (layoutChanged.length)
          await this.put(active, [this.asEntry(projected, active)], requestId);
      }
      const localChanges = Object.fromEntries(
        Object.entries(changed).filter(
          ([field]) =>
            field === "projectId" ||
            field === "archivedAt" ||
            !LAYOUT_FIELDS.includes(field as (typeof LAYOUT_FIELDS)[number]),
        ),
      );
      const result = await super.update(id, (latest) =>
        Object.assign({}, latest, localChanges, this.protectionFields(projected)),
      );
      return result ? this.project(result) : null;
    }, context?.requestId);
  }

  override upsert(
    record: PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<void> {
    return this.serial(async (requestId) => {
      const previous = await super.get(record.workspaceId);
      if (previous) {
        // Reconciliation passes whole records, often from an older read. It is
        // never a second layout writer and must preserve the canonical fields.
        await super.upsert(
          Object.assign({}, record, this.protectionFields(this.project(previous)), {
            projectId: previous.projectId,
            archivedAt: previous.archivedAt,
          }),
          context,
        );
        return;
      }
      const snapshot = await this.freshActive();
      const canonical = snapshot.entries.find(
        (entry) =>
          entry.ref.serverId === this.serverId && entry.ref.workspaceId === record.workspaceId,
      );
      if (canonical) throw new WorkspaceLayoutRefusal("local_workspace_identity_collision");
      const initial = {
        ...record,
        siblingOrder: record.siblingOrder ?? this.nextOrder(snapshot, record),
      };
      await this.put(snapshot, [this.asEntry(initial, snapshot)], requestId);
      await super.upsert(initial, context);
      // The legacy registry may allocate a rank while inserting. The local
      // protection copy must retain the authority's already-committed rank.
      await super.update(initial.workspaceId, (latest) =>
        Object.assign({}, latest, this.protectionFields(initial)),
      );
    }, context?.requestId);
  }

  override move(
    id: string,
    input: WorkspaceMoveInput,
    context?: WorkspaceMutationContext,
  ): Promise<PersistedWorkspaceRecord> {
    return this.serial(async (requestId) => {
      const snapshot = await this.freshActive();
      const raw = await super.get(id);
      if (!raw || raw.archivedAt) throw new WorkspaceLayoutRefusal("workspace_not_active");
      const current = this.project(raw, snapshot);
      const local = new Map((await super.list()).map((record) => [record.workspaceId, record]));
      const name = (entry: WorkspaceLayoutEntry) => {
        const record = local.get(entry.ref.workspaceId);
        if (!record) throw new WorkspaceLayoutRefusal("missing_local_order_observation");
        return resolveWorkspaceDisplayName(record);
      };
      const siblings = snapshot.entries
        .filter(
          (entry) =>
            entry.ref.serverId === this.serverId &&
            entry.ref.workspaceId !== id &&
            entry.projectId === current.projectId &&
            !entry.archivedAt &&
            (entry.parent?.workspaceId ?? null) === input.parentWorkspaceId,
        )
        .sort((a, b) => {
          if (a.siblingOrder !== null) {
            if (b.siblingOrder === null) return -1;
            return (
              a.siblingOrder - b.siblingOrder || a.ref.workspaceId.localeCompare(b.ref.workspaceId)
            );
          }
          if (b.siblingOrder !== null) return 1;
          return (
            name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" }) ||
            a.ref.workspaceId.localeCompare(b.ref.workspaceId)
          );
        });
      const index =
        input.beforeWorkspaceId == null
          ? siblings.length
          : siblings.findIndex((entry) => entry.ref.workspaceId === input.beforeWorkspaceId);
      if (index < 0) throw new WorkspaceLayoutRefusal("invalid_destination_sibling");
      const changes: WorkspaceLayoutEntry[] = [];
      const rebalance = () => {
        for (let position = 0; position < siblings.length; position++) {
          siblings[position] = { ...siblings[position], siblingOrder: position };
          changes.push(siblings[position]);
        }
      };
      // An explicit move may rank a previously unranked group, preserving the
      // actual numeric-then-name order rather than assigning import-time zeros.
      if (siblings.some((entry) => entry.siblingOrder === null)) rebalance();
      const order = () => orderBetween(siblings, index);
      let siblingOrder = order();
      if (
        !Number.isFinite(siblingOrder) ||
        (index > 0 && siblingOrder <= numericRank(siblings[index - 1])) ||
        (index < siblings.length && siblingOrder >= numericRank(siblings[index]))
      ) {
        rebalance();
        siblingOrder = order();
      }
      const next = { ...current, parentWorkspaceId: input.parentWorkspaceId, siblingOrder };
      changes.push(this.asEntry(next, snapshot));
      await this.put(snapshot, changes, requestId);
      const updated = await super.update(id, (latest) =>
        Object.assign({}, latest, this.protectionFields(next)),
      );
      if (!updated) throw new WorkspaceLayoutRefusal("local_projection_failed");
      return this.project(updated);
    }, context?.requestId);
  }

  override async archive(): Promise<boolean> {
    throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  }
  override async remove(): Promise<void> {
    throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.queue;
    await this.projection;
  }

  private serial<T>(
    run: (requestId: string) => Promise<T>,
    originalRequestId: string = randomUUID(),
  ): Promise<T> {
    const result = this.queue.then(() => this.retryGlobalCas(run, originalRequestId, 0));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async retryGlobalCas<T>(
    run: (requestId: string) => Promise<T>,
    requestId: string,
    attempt: number,
  ): Promise<T> {
    try {
      return await run(requestId);
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "stale_revision"
      )
        throw error;
      // A definite refusal applied nothing. Re-run pure intent/revision guards;
      // unknown outcomes and entry conflicts never enter this bounded path.
      return this.retryGlobalCas(run, randomUUID(), attempt + 1);
    }
  }

  private async freshActive(): Promise<WorkspaceLayoutSnapshot> {
    const snapshot = await this.layout.inspect();
    if (snapshot.stamp.phase !== "active") throw new WorkspaceLayoutRefusal("layout_importing");
    return snapshot;
  }

  private async put(
    snapshot: WorkspaceLayoutSnapshot,
    entries: WorkspaceLayoutEntry[],
    requestId: string = randomUUID(),
  ) {
    return this.layout.commit({
      requestId,
      expected: snapshot.stamp,
      mutations: entries.map((entry) => ({ kind: "put", entry })),
    });
  }

  private nextOrder(snapshot: WorkspaceLayoutSnapshot, record: PersistedWorkspaceRecord) {
    const siblings = snapshot.entries.filter(
      (entry) =>
        entry.ref.serverId === this.serverId &&
        entry.projectId === record.projectId &&
        (entry.parent?.workspaceId ?? null) === (record.parentWorkspaceId ?? null) &&
        !entry.archivedAt,
    );
    // Until an explicit move ranks the group, preserve its legacy name order.
    if (siblings.some((entry) => entry.siblingOrder === null)) return undefined;
    const order = siblings.length ? Math.max(...siblings.map(numericRank)) + 1 : 0;
    if (!Number.isFinite(order)) throw new WorkspaceLayoutRefusal("sibling_order_exhausted");
    return order;
  }

  private asEntry(
    record: PersistedWorkspaceRecord,
    snapshot: WorkspaceLayoutSnapshot,
  ): WorkspaceLayoutEntry {
    const ref = { serverId: this.serverId, workspaceId: record.workspaceId };
    const previous = snapshot.entries.find(
      (entry) => workspaceReferenceKey(entry.ref) === workspaceReferenceKey(ref),
    );
    return {
      ref,
      projectId: record.projectId,
      pinnedAt: record.pinnedAt,
      superpinnedAt: record.superpinnedAt,
      parent: record.parentWorkspaceId
        ? { serverId: this.serverId, workspaceId: record.parentWorkspaceId }
        : null,
      siblingOrder: record.siblingOrder ?? null,
      pinPlacement: record.pinPlacement ?? null,
      archivedAt: record.archivedAt,
      revision: previous?.revision ?? 0,
    };
  }

  private project(
    record: PersistedWorkspaceRecord,
    snapshot = this.layout.cached().snapshot,
  ): PersistedWorkspaceRecord {
    // Import is a declared read-only staging phase. Existing local facts remain
    // visible, but neither a legacy RPC nor a reconcile can import them by writing.
    if (!snapshot || snapshot.stamp.phase === "importing") return record;
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.ref.serverId === this.serverId &&
        candidate.ref.workspaceId === record.workspaceId,
    );
    if (!entry) throw new WorkspaceLayoutRefusal("workspace_not_imported");
    return {
      ...record,
      pinnedAt: entry.pinnedAt,
      superpinnedAt: entry.superpinnedAt,
      parentWorkspaceId: entry.parent?.workspaceId ?? null,
      siblingOrder: entry.siblingOrder ?? undefined,
      pinPlacement: entry.pinPlacement ?? undefined,
    };
  }

  private protectionFields(record: PersistedWorkspaceRecord) {
    return {
      pinnedAt: record.pinnedAt,
      superpinnedAt: record.superpinnedAt,
      parentWorkspaceId: record.parentWorkspaceId,
      siblingOrder: record.siblingOrder,
      pinPlacement: record.pinPlacement,
    };
  }

  private projectOrQuarantine(
    record: PersistedWorkspaceRecord,
    snapshot = this.layout.cached().snapshot,
  ) {
    try {
      return this.project(record, snapshot);
    } catch (error) {
      if (!(error instanceof WorkspaceLayoutRefusal) || error.code !== "workspace_not_imported")
        throw error;
      this.logger.error(
        { workspaceId: record.workspaceId, code: error.code },
        "Workspace absent from canonical layout; retained locally and isolated from directory publication",
      );
      return null;
    }
  }

  private async syncProtectionProjection(): Promise<void> {
    const snapshot = this.layout.cached().snapshot;
    if (!snapshot || snapshot.stamp.phase !== "active") return;
    for (const raw of await super.list()) {
      const next = this.projectOrQuarantine(raw, snapshot);
      if (!next) continue;
      if (!isDeepStrictEqual(this.protectionFields(raw), this.protectionFields(next)))
        await super.update(raw.workspaceId, (latest) =>
          Object.assign({}, latest, this.protectionFields(next)),
        );
    }
  }
}

function changedFields(before: PersistedWorkspaceRecord, after: PersistedWorkspaceRecord) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as Array<
    keyof PersistedWorkspaceRecord
  >);
  return Object.fromEntries(
    [...keys]
      .filter((key) => !isDeepStrictEqual(before[key], after[key]))
      .map((key) => [key, after[key]]),
  );
}

function orderBetween(siblings: WorkspaceLayoutEntry[], index: number): number {
  if (!siblings.length) return 0;
  if (index === 0) return numericRank(siblings[0]) - 1;
  if (index === siblings.length) return numericRank(siblings[index - 1]) + 1;
  return numericRank(siblings[index - 1]) / 2 + numericRank(siblings[index]) / 2;
}

function numericRank(entry: WorkspaceLayoutEntry): number {
  if (entry.siblingOrder === null) throw new WorkspaceLayoutRefusal("unranked_destination");
  return entry.siblingOrder;
}

export function createWorkspaceRegistry(
  file: string,
  logger: Logger,
  service: WorkspaceLayoutService | undefined,
  serverId: string,
) {
  return service
    ? new CanonicalWorkspaceRegistry(file, logger, service, serverId)
    : new FileBackedWorkspaceRegistry(file, logger);
}
