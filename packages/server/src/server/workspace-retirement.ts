import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WorkspaceLayoutCommitSchema,
  WorkspaceRetirementOutcomeSchema,
  WorkspaceLayoutIdentitySchema,
  WorkspaceLayoutHomeMarkerSchema,
  workspaceReferenceKey,
  type WorkspaceLayoutCommit,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutSnapshot,
  type WorkspaceRetirement,
} from "@getpaseo/protocol/workspace-layout";
import type { WorkspaceLayoutService } from "./workspace-layout-service.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { hashLayoutValue, WorkspaceLayoutRefusal } from "./workspace-layout-store.js";
import { writeFileDurably } from "./atomic-file.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertWorkspaceAutomationAllowed } from "./workspace-automation-gate.js";

interface RetirementContext {
  active: boolean;
  archiveTimestamp: string;
  archive: () => Promise<void>;
  home: string;
  workspaceIds: ReadonlySet<string>;
  verify: () => Promise<void>;
  step: <T>(name: string, effect: () => Promise<T>) => Promise<T>;
}
const currentRetirement = new AsyncLocalStorage<RetirementContext>();
async function withWorkspaceRetirement<T>(
  context: Omit<RetirementContext, "active">,
  run: () => Promise<T>,
): Promise<T> {
  const lease = { ...context, active: true };
  try {
    return await currentRetirement.run(lease, run);
  } finally {
    lease.active = false;
  }
}
export async function requireWorkspaceRetirement(
  home: string,
  workspaceId?: string,
): Promise<void> {
  const context = currentRetirement.getStore();
  if (
    !context ||
    !context.active ||
    path.resolve(context.home) !== path.resolve(home) ||
    (workspaceId !== undefined && !context.workspaceIds.has(workspaceId))
  )
    throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  await context.verify();
}
export async function workspaceRetirementStep<T>(
  name: string,
  effect: () => Promise<T>,
): Promise<T> {
  const context = currentRetirement.getStore();
  if (!context) return effect();
  if (!context.active) throw new WorkspaceLayoutRefusal("retirement_execution_closed");
  await context.verify();
  return context.step(name, effect);
}
export async function workspaceRetirementArchiveTimestamp(
  home: string,
  id: string,
): Promise<string> {
  await requireWorkspaceRetirement(home, id);
  return currentRetirement.getStore()!.archiveTimestamp;
}
export async function commitWorkspaceRetirementArchive(): Promise<void> {
  const context = currentRetirement.getStore();
  if (!context || !context.active)
    throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  await context.verify();
  await context.archive();
}
export function hasWorkspaceRetirement(): boolean {
  return currentRetirement.getStore() !== undefined;
}

export type RetirementAuthority = Pick<
  WorkspaceLayoutService,
  "inspect" | "commit" | "findReceipt" | "options"
>;
const ResultSchema = z.object({
  archivedAgentIds: z.array(z.string()),
  archivedWorkspaceIds: z.array(z.string()),
  removedDirectory: z.boolean(),
  directoryLeftBehind: z.object({ path: z.string(), reason: z.string() }).optional(),
  slotKept: z.boolean().optional(),
  retirement: WorkspaceRetirementOutcomeSchema.optional(),
});
export type RetirementResult = z.infer<typeof ResultSchema>;
const JournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: WorkspaceLayoutIdentitySchema,
  operationId: z.string().uuid(),
  nativeGeneration: z.string(),
  backingPath: z.string(),
  backingPaths: z.array(z.string()),
  backingGeneration: z.string(),
  intents: z.array(WorkspaceLayoutCommitSchema),
  steps: z.record(z.string(), z.enum(["started", "done"])),
  result: ResultSchema.nullable(),
  closedWithoutReservation: z.boolean(),
  archiveTimestamp: z.string().datetime(),
});
type RetirementJournal = z.infer<typeof JournalSchema>;
interface RetirementInput {
  expectedProjectId?: string;
  authority: RetirementAuthority;
  records: PersistedWorkspaceRecord[];
  backing: string;
  run: () => Promise<RetirementResult>;
  getRecord: (id: string) => Promise<PersistedWorkspaceRecord | null>;
  assertHolds: (id: string) => Promise<void>;
  nativeInventory: () => Promise<PersistedWorkspaceRecord[]>;
}

export type NativeWorkspaceIdentity = Pick<
  PersistedWorkspaceRecord,
  | "workspaceId"
  | "createdAt"
  | "cwd"
  | "worktreeRoot"
  | "mainRepoRoot"
  | "kind"
  | "isPaseoOwnedWorktree"
>;
export function nativeGeneration(records: readonly NativeWorkspaceIdentity[]): string {
  return hashLayoutValue(
    records
      .map((record) => ({
        workspaceId: record.workspaceId,
        createdAt: record.createdAt,
        cwd: path.resolve(record.cwd),
        worktreeRoot: record.worktreeRoot,
        mainRepoRoot: record.mainRepoRoot,
        kind: record.kind,
        isPaseoOwnedWorktree: record.isPaseoOwnedWorktree,
      }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  );
}
async function canonicalBacking(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalBacking(parent), path.basename(absolute));
  }
}
function relativeChild(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function backingPathsOverlap(first: string, second: string): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalBacking(first), canonicalBacking(second)]);
  return relativeChild(path.relative(left, right)) || relativeChild(path.relative(right, left));
}
async function refsAtBacking(
  refs: readonly Pick<PersistedWorkspaceRecord, "workspaceId" | "cwd" | "worktreeRoot">[],
  backing: string,
): Promise<string[]> {
  const root = await canonicalBacking(backing);
  const paths = await Promise.all(refs.map((ref) => canonicalBacking(ref.worktreeRoot ?? ref.cwd)));
  return refs
    .filter((_ref, index) => relativeChild(path.relative(root, paths[index])))
    .map((ref) => ref.workspaceId)
    .sort();
}

/** A local effect journal is evidence of execution, never a substitute for the authority reservation. */
export async function retireCanonicalWorkspace(input: RetirementInput): Promise<RetirementResult> {
  const { authority, records, backing } = input;
  if (!records.length) throw new WorkspaceLayoutRefusal("retirement_native_footprint_required");
  const home = authority.options.home;
  const marker = WorkspaceLayoutHomeMarkerSchema.parse(
    JSON.parse(await readFile(path.join(home, "workspace-layout-mode.json"), "utf8")),
  );
  const { schemaVersion: _markerVersion, destructiveRetirement: _retirement, ...bound } = marker;
  if (hashLayoutValue(bound) !== hashLayoutValue(authority.options.config))
    throw new WorkspaceLayoutRefusal("home_authority_binding_changed");
  const generation = nativeGeneration(records);
  const journalDirectory = path.join(home, "workspace-retirements");
  const file = path.join(journalDirectory, `${generation}.json`);
  const replay = await replayRetirement({ authority, records, generation, file, journalDirectory });
  if (replay) return replay;
  await requireLiveNativeTargets(input);
  const freshBefore = await authority.inspect();
  const identity = WorkspaceLayoutIdentitySchema.parse(authority.options.config);
  const backingPaths = [
    ...new Set(records.map((record) => path.resolve(record.worktreeRoot ?? record.cwd))),
  ];
  for (const backingPath of backingPaths)
    await assertWorkspaceBackingAvailable(
      home,
      backingPath,
      freshBefore,
      authority.options.serverId,
    );
  async function observeBackings() {
    const allRefs = (await input.nativeInventory()).filter((record) => !record.archivedAt);
    return Promise.all(
      backingPaths.map(async (backingPath) => {
        const ids = new Set(await refsAtBacking(allRefs, backingPath));
        const shared = allRefs.filter(
          (record) =>
            ids.has(record.workspaceId) &&
            !records.some((target) => target.workspaceId === record.workspaceId),
        );
        return {
          path: backingPath,
          refs: nativeGeneration(shared),
          stat: await stat(backingPath)
            .then((value) => ({ dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs }))
            .catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              return null;
            }),
        };
      }),
    );
  }
  const observed = await observeBackings();
  async function verifyNativeInventory(snapshotBefore: WorkspaceLayoutSnapshot) {
    const allNative = await input.nativeInventory();
    const nativeIds = new Set(allNative.map((record) => record.workspaceId));
    if (
      snapshotBefore.entries.some(
        (entry) =>
          entry.ref.serverId === authority.options.serverId &&
          !nativeIds.has(entry.ref.workspaceId) &&
          (!entry.archivedAt || entry.pinnedAt || entry.superpinnedAt),
      )
    )
      throw new WorkspaceLayoutRefusal("retirement_owner_inventory_incomplete");
    const affected = new Set(
      (
        await Promise.all(backingPaths.map((backingPath) => refsAtBacking(allNative, backingPath)))
      ).flat(),
    );
    for (const native of allNative) {
      if (!affected.has(native.workspaceId)) continue;
      if (native.archivedAt) {
        if (
          native.pinnedAt ||
          native.superpinnedAt ||
          /do not archive/i.test(`${native.title ?? ""} ${native.displayName}`)
        )
          throw new WorkspaceLayoutRefusal("retirement_native_hold");
        continue;
      }
      const entry = snapshotBefore.entries.find(
        (candidate) =>
          candidate.ref.serverId === authority.options.serverId &&
          candidate.ref.workspaceId === native.workspaceId,
      );
      if (
        !entry ||
        snapshotBefore.ownerDomains?.find((domain) => domain.serverId === entry.ref.serverId)
          ?.state !== "adopted"
      )
        throw new WorkspaceLayoutRefusal("retirement_affected_owner_unknown");
    }
  }
  await verifyNativeInventory(await authority.inspect());
  const backingGeneration = hashLayoutValue({ observed, generation });
  const operationId = randomUUID();
  const journal: z.infer<typeof JournalSchema> = {
    schemaVersion: 1,
    identity,
    operationId,
    nativeGeneration: generation,
    backingPath: path.resolve(backing),
    backingPaths,
    backingGeneration,
    intents: [],
    steps: {},
    result: null,
    closedWithoutReservation: false,
    archiveTimestamp: new Date().toISOString(),
  };
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  let writes: Promise<unknown> = Promise.resolve();
  const persist = () => {
    const bytes = `${JSON.stringify(journal)}\n`;
    const write = writes.then(() => writeFileDurably(file, bytes));
    writes = write;
    return write;
  };
  await persist();
  async function commit(mutation: WorkspaceLayoutMutation) {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await authority.inspect();
      const intent: WorkspaceLayoutCommit = {
        writerVersion: 3,
        requestId: `retire:${operationId}:${journal.intents.length}`,
        expected: snapshot.stamp,
        mutations: [mutation],
      };
      journal.intents.push(intent);
      await persist();
      try {
        return await authority.commit(intent);
      } catch (error) {
        const receipt = await authority.findReceipt(intent.requestId);
        if (receipt) {
          if (receipt.requestSha256 !== hashLayoutValue(intent))
            throw new WorkspaceLayoutRefusal("retirement_receipt_conflict");
          return receipt;
        }
        if (
          attempt < 2 &&
          error instanceof Error &&
          "code" in error &&
          error.code === "stale_revision"
        )
          continue;
        throw error;
      }
    }
  }
  const targetIds = new Set(records.map((record) => record.workspaceId));
  async function verify() {
    const snapshot = await authority.inspect();
    await verifyNativeInventory(snapshot);
    for (const original of records) {
      const record = await input.getRecord(original.workspaceId);
      if (!record || nativeGeneration([record]) !== nativeGeneration([original]))
        throw new WorkspaceLayoutRefusal("retirement_native_generation_changed");
      if (
        record.pinnedAt ||
        record.superpinnedAt ||
        /do not archive/i.test(`${record.title ?? ""} ${record.displayName}`)
      )
        throw new WorkspaceLayoutRefusal("retirement_native_hold");
      assertWorkspaceAutomationAllowed(record.untrustedSource);
      await input.assertHolds(record.workspaceId);
    }
    const operation = snapshot.retirements?.find((op) => op.operationId === operationId);
    if (
      !operation ||
      operation.state === "complete" ||
      operation.backingGeneration !== backingGeneration ||
      operation.ownerServerId !== authority.options.serverId ||
      (operation.state === "archived" && operation.archivedAt !== journal.archiveTimestamp)
    )
      throw new WorkspaceLayoutRefusal("retirement_reservation_unverified");
    if (hashLayoutValue(await observeBackings()) !== hashLayoutValue(observed))
      throw new WorkspaceLayoutRefusal("retirement_backing_generation_changed");
  }
  try {
    const snapshot = await authority.inspect();
    await commit({
      kind: "reserve-retirement",
      operationId,
      ownerServerId: authority.options.serverId,
      backingGeneration,
      targets: records.map((record) => {
        const ref = { serverId: authority.options.serverId, workspaceId: record.workspaceId };
        const entry = snapshot.entries.find(
          (row) => workspaceReferenceKey(row.ref) === workspaceReferenceKey(ref),
        );
        if (!entry) throw new WorkspaceLayoutRefusal("workspace_not_imported");
        if (input.expectedProjectId && entry.projectId !== input.expectedProjectId)
          throw new WorkspaceLayoutRefusal("retirement_project_changed");
        return { ref, revision: entry.revision };
      }),
    });
    // A rollback binary must refuse this owner home before it can run legacy teardown.
    await writeFileDurably(
      path.join(home, "workspace-layout-mode.json"),
      JSON.stringify({
        ...authority.options.config,
        schemaVersion: 3,
        destructiveRetirement: "refuse",
      }),
    );
    const result = await withWorkspaceRetirement(
      {
        home,
        workspaceIds: targetIds,
        archiveTimestamp: journal.archiveTimestamp,
        archive: async () => {
          if (
            records.some(
              (record) => journal.steps[`native-archive:${record.workspaceId}`] !== "done",
            ) ||
            Object.values(journal.steps).some((state) => state !== "done")
          )
            throw new WorkspaceLayoutRefusal("retirement_partial_teardown");
          await commit({
            kind: "archive-retirement",
            operationId,
            archivedAt: journal.archiveTimestamp,
          });
        },
        verify,
        step: async (name, effect) => {
          if (journal.steps[name])
            throw new WorkspaceLayoutRefusal("retirement_effect_already_started");
          if (name === "remove-directory" || name.startsWith("path-teardown:")) {
            const stageSnapshot = await authority.inspect();
            if (
              stageSnapshot.retirements?.find((operation) => operation.operationId === operationId)
                ?.state !== "archived"
            )
              throw new WorkspaceLayoutRefusal("retirement_archive_receipt_required");
          }
          journal.steps[name] = "started";
          await persist();
          const value = await effect();
          journal.steps[name] = "done";
          await persist();
          return value;
        },
      },
      input.run,
    );
    if (
      result.archivedWorkspaceIds.length !== records.length ||
      Object.values(journal.steps).some((state) => state !== "done")
    )
      throw new WorkspaceLayoutRefusal("retirement_partial_teardown");
    journal.result = {
      ...result,
      retirement: { operationId, state: "partial", code: "completion_pending" },
    };
    await persist();
    const receipt = await commit({ kind: "complete-retirement", operationId });
    journal.result = { ...result, retirement: { operationId, state: "complete", receipt } };
    await persist();
    return journal.result;
  } catch (error) {
    return recordRetirementFailure({ error, journal, authority, persist });
  }
}
interface ReplayInput {
  authority: RetirementAuthority;
  records: PersistedWorkspaceRecord[];
  generation: string;
  file: string;
  journalDirectory: string;
}
async function readOptionalJournal(file: string): Promise<RetirementJournal | null> {
  try {
    return JournalSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function assertReplayBinding(
  journal: RetirementJournal,
  input: ReplayInput,
  operation: WorkspaceRetirement | undefined,
): void {
  const identity = WorkspaceLayoutIdentitySchema.parse(input.authority.options.config);
  if (
    journal.nativeGeneration !== input.generation ||
    hashLayoutValue(journal.identity) !== hashLayoutValue(identity)
  )
    throw new WorkspaceLayoutRefusal("retirement_journal_binding_changed");
  if (
    operation &&
    (operation.backingGeneration !== journal.backingGeneration ||
      operation.ownerServerId !== input.authority.options.serverId ||
      hashLayoutValue(operation.targets.map((target) => target.ref.workspaceId).sort()) !==
        hashLayoutValue(input.records.map((record) => record.workspaceId).sort()))
  )
    throw new WorkspaceLayoutRefusal("retirement_journal_binding_changed");
}
function completionKnown(
  journal: RetirementJournal,
  operation: WorkspaceRetirement | undefined,
): boolean {
  const effectsKnown = Object.values(journal.steps).every((step) => step === "done");
  const completed =
    journal.result?.retirement?.state === "complete" ||
    journal.result?.retirement?.code === "completion_pending";
  return journal.result !== null && operation?.state === "complete" && effectsKnown && completed;
}
async function completedReplay(
  journal: RetirementJournal,
  input: ReplayInput,
): Promise<RetirementResult> {
  const intent = journal.intents.at(-1);
  const receipt = intent ? await input.authority.findReceipt(intent.requestId) : null;
  if (
    !receipt ||
    !intent ||
    receipt.requestSha256 !== hashLayoutValue(intent) ||
    !intent.mutations.some(
      (mutation) =>
        mutation.kind === "complete-retirement" && mutation.operationId === journal.operationId,
    )
  )
    throw new WorkspaceLayoutRefusal("retirement_completion_receipt_unavailable");
  if (!journal.result) throw new WorkspaceLayoutRefusal("retirement_result_missing");
  const result = {
    ...journal.result,
    retirement: { operationId: journal.operationId, state: "complete" as const, receipt },
  };
  await writeFileDurably(input.file, JSON.stringify({ ...journal, result }));
  return result;
}
async function replayRetirement(input: ReplayInput): Promise<RetirementResult | null> {
  const journal = await readOptionalJournal(input.file);
  if (!journal) return null;
  const snapshot = await input.authority.inspect();
  const operation = snapshot.retirements?.find(
    (candidate) => candidate.operationId === journal.operationId,
  );
  assertReplayBinding(journal, input, operation);
  if (completionKnown(journal, operation)) return completedReplay(journal, input);
  if (journal.closedWithoutReservation && !operation) {
    const history = path.join(input.journalDirectory, "history");
    await mkdir(history, { recursive: true, mode: 0o700 });
    await writeFileDurably(
      path.join(history, `${journal.operationId}.json`),
      JSON.stringify(journal),
    );
    return null;
  }
  return {
    ...(journal.result ?? partial(journal.operationId, "retirement_reconciliation_required")),
    retirement: {
      operationId: journal.operationId,
      state: "partial",
      code: "retirement_reconciliation_required",
    },
  };
}
function nativeHold(record: PersistedWorkspaceRecord): boolean {
  return Boolean(
    record.pinnedAt ||
    record.superpinnedAt ||
    /do not archive/i.test(`${record.title ?? ""} ${record.displayName}`),
  );
}
async function requireLiveNativeTargets(input: RetirementInput): Promise<void> {
  for (const record of input.records) {
    assertWorkspaceAutomationAllowed(record.untrustedSource);
    await input.assertHolds(record.workspaceId);
    if (record.archivedAt)
      throw new WorkspaceLayoutRefusal("retirement_native_generation_archived");
    if (nativeHold(record)) throw new WorkspaceLayoutRefusal("retirement_native_hold");
  }
}
interface RetirementFailureInput {
  error: unknown;
  journal: RetirementJournal;
  authority: RetirementAuthority;
  persist: () => Promise<void>;
}
async function recordRetirementFailure({
  error,
  journal,
  authority,
  persist,
}: RetirementFailureInput): Promise<RetirementResult> {
  const refused =
    error instanceof WorkspaceLayoutRefusal ||
    (error instanceof DaemonRpcError && error.requestType === "workspace.layout.commit.request");
  const code = refused ? (error.code ?? "retirement_effect_failed") : "retirement_effect_failed";
  const definiteRefusals = new Set([
    "layout_importing",
    "retirement_project_changed",
    "entry_revision_conflict",
    "stale_revision",
    "retirement_protected",
    "retirement_ancestry_unresolved",
    "retirement_live_descendant",
    "retirement_owner_unavailable",
    "retirement_conflict",
    "retirement_cross_owner_dependency",
  ]);
  if (Object.keys(journal.steps).length === 0 && refused && definiteRefusals.has(code)) {
    const snapshot = await authority.inspect();
    journal.closedWithoutReservation = !snapshot.retirements?.some(
      (candidate) => candidate.operationId === journal.operationId,
    );
  }
  journal.result = {
    ...partial(journal.operationId, code),
    archivedWorkspaceIds: Object.keys(journal.steps)
      .filter((key) => key.startsWith("native-archive:") && journal.steps[key] === "done")
      .map((key) => key.slice("native-archive:".length)),
    archivedAgentIds: Object.keys(journal.steps)
      .filter((key) => /^(agent|snapshot):/.test(key) && journal.steps[key] === "done")
      .map((key) => key.slice(key.indexOf(":") + 1)),
    removedDirectory: journal.steps["remove-directory"] === "done",
  };
  try {
    await persist();
  } catch {
    // The last durable intent remains the fence. Report uncertainty even when
    // the failing disk cannot also persist this outcome; never re-run its effect.
    journal.result.retirement = {
      operationId: journal.operationId,
      state: "partial",
      code: "retirement_journal_persistence_failed",
    };
  }
  return journal.result;
}
function partial(operationId: string, code: string): RetirementResult {
  return {
    archivedAgentIds: [],
    archivedWorkspaceIds: [],
    removedDirectory: false,
    retirement: { operationId, state: "partial", code },
  };
}

export async function assertWorkspaceBackingAvailable(
  home: string,
  backing: string,
  snapshot: WorkspaceLayoutSnapshot,
  ownerServerId: string,
): Promise<void> {
  let files: string[];
  const directory = path.join(home, "workspace-retirements");
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  const journals = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        JournalSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8"))),
      ),
  );
  for (const operation of snapshot.retirements ?? []) {
    if (operation.ownerServerId !== ownerServerId || operation.state === "complete") continue;
    if (
      !journals.some(
        (journal) =>
          journal.operationId === operation.operationId &&
          journal.backingGeneration === operation.backingGeneration,
      )
    )
      throw new WorkspaceLayoutRefusal("retirement_owner_journal_missing");
  }
  for (const journal of journals) {
    const operation = snapshot.retirements?.find(
      (candidate) => candidate.operationId === journal.operationId,
    );
    if (journal.closedWithoutReservation && !operation) continue;
    if (
      journal.result?.retirement?.state === "complete" &&
      operation?.state === "complete" &&
      operation.backingGeneration === journal.backingGeneration
    )
      continue;
    for (const reservedPath of journal.backingPaths)
      if (await backingPathsOverlap(reservedPath, backing))
        throw new WorkspaceLayoutRefusal("retirement_backing_reserved");
  }
}

/** This only fences native observation writes; it never authorizes layout or filesystem effects. */
export async function refuseRetirementObservationConflict(
  home: string,
  id: string,
  paths: string[],
): Promise<void> {
  const directory = path.join(home, "workspace-retirements");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
    const journal = JournalSchema.parse(
      JSON.parse(await readFile(path.join(directory, file), "utf8")),
    );
    if (journal.closedWithoutReservation) continue;
    if (
      journal.intents.some((intent) =>
        intent.mutations.some(
          (mutation) =>
            mutation.kind === "reserve-retirement" &&
            mutation.targets.some((target) => target.ref.workspaceId === id),
        ),
      )
    )
      throw new WorkspaceLayoutRefusal("retired_workspace_identity");
    if (journal.result?.retirement?.state === "complete") continue;
    for (const candidate of paths)
      for (const reserved of journal.backingPaths)
        if (await backingPathsOverlap(reserved, candidate))
          throw new WorkspaceLayoutRefusal("retirement_backing_reserved");
  }
}
