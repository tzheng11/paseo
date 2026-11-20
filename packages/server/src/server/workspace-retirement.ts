import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutIdentitySchema,
  WorkspaceLayoutHomeMarkerSchema,
  WorkspaceRetirementResultSchema,
  WorkspaceRetirementOperationSchema,
  WorkspaceRetirementBindingSchema,
  type WorkspaceRetirementOperation,
  type WorkspaceRetirementBinding,
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
import {
  assertWorkspaceAutomationAllowed,
  WorkspaceAutomationBlockedError,
} from "./workspace-automation-gate.js";
import { serializeWorkspaceBacking, nativeTransitionKey } from "./workspace-retirement-context.js";

interface RetirementContext {
  operationId: string;
  backingGeneration: string;
  verifyHook: (binding: WorkspaceRetirementBinding) => Promise<void>;
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
const ResultSchema = WorkspaceRetirementResultSchema;
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
  operationId?: string;
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
  const replay = await replayRetirement({
    authority,
    records,
    generation,
    file,
    journalDirectory,
    operationId: input.operationId,
  });
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
  const operationId = input.operationId ?? randomUUID();
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
        operationId,
        backingGeneration,
        verifyHook: async (binding) => {
          await verify();
          const record = records.find((candidate) => candidate.workspaceId === binding.workspaceId);
          if (
            !record ||
            journal.steps[`path-teardown:${binding.teardownCwd}`] !== "started" ||
            path.resolve(record.cwd) !== path.resolve(binding.teardownCwd) ||
            path.resolve(record.worktreeRoot ?? record.cwd) !== path.resolve(binding.worktreePath)
          )
            throw new WorkspaceLayoutRefusal("retirement_hook_binding_changed");
          const hookSnapshot = await authority.inspect();
          if (
            hookSnapshot.retirements?.find((operation) => operation.operationId === operationId)
              ?.state !== "archived"
          )
            throw new WorkspaceLayoutRefusal("retirement_archive_receipt_required");
        },
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
  operationId?: string;
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
  if (
    input.operationId &&
    input.operationId !== journal.operationId &&
    !(journal.closedWithoutReservation && !operation)
  )
    throw new WorkspaceLayoutRefusal("retirement_operation_id_conflict");
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

const CallerOperationSchema = WorkspaceRetirementOperationSchema.extend({
  schemaVersion: z.literal(1),
  identity: WorkspaceLayoutIdentitySchema,
  nativeGeneration: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
type CallerOperation = z.infer<typeof CallerOperationSchema>;
const runningCallerOperations = new Set<string>();
function operationFile(authority: RetirementAuthority, operationId: string): string {
  const id = z.string().uuid().parse(operationId).toLowerCase();
  return path.join(authority.options.home, "workspace-retirement-operations", `${id}.json`);
}
async function readCallerOperation(
  authority: RetirementAuthority,
  operationId: string,
): Promise<CallerOperation | null> {
  try {
    const record = CallerOperationSchema.parse(
      JSON.parse(await readFile(operationFile(authority, operationId), "utf8")),
    );
    if (
      record.operationId !== z.string().uuid().parse(operationId).toLowerCase() ||
      (record.result?.retirement && record.result.retirement.operationId !== record.operationId) ||
      record.ownerServerId !== authority.options.serverId ||
      hashLayoutValue(record.identity) !==
        hashLayoutValue(WorkspaceLayoutIdentitySchema.parse(authority.options.config))
    )
      throw new WorkspaceLayoutRefusal("retirement_operation_binding_changed");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function callerJournal(
  authority: RetirementAuthority,
  record: CallerOperation,
): Promise<RetirementJournal | null> {
  if (!record.nativeGeneration) return null;
  const journal = await readOptionalJournal(
    path.join(authority.options.home, "workspace-retirements", `${record.nativeGeneration}.json`),
  );
  if (
    journal?.operationId === record.operationId &&
    (journal.nativeGeneration !== record.nativeGeneration ||
      hashLayoutValue(journal.identity) !== hashLayoutValue(record.identity))
  )
    throw new WorkspaceLayoutRefusal("retirement_operation_binding_changed");
  return journal?.operationId === record.operationId ? journal : null;
}
function operationState(
  result: RetirementResult | null,
  closedWithoutReservation: boolean,
  running: boolean,
): WorkspaceRetirementOperation["state"] {
  if (result?.retirement?.state === "complete") return "complete";
  if (closedWithoutReservation) return "refused";
  if (!result && running) return "pending";
  return "partial";
}
function setCallerOutcome(
  record: CallerOperation,
  journal: RetirementJournal | null,
  result: RetirementResult | null,
  error?: unknown,
): void {
  record.result = result;
  record.backingGeneration = journal?.backingGeneration ?? null;
  record.state = operationState(result, journal?.closedWithoutReservation ?? false, false);
  if (error !== undefined && !journal) record.state = "refused";
  record.terminal = record.state === "complete" || record.state === "refused";
  record.code = result?.retirement?.code ?? null;
  if (error !== undefined && record.state !== "complete") record.code = refusalCode(error);
}
async function unindexedOperation(
  authority: RetirementAuthority,
  operationId: string,
): Promise<WorkspaceRetirementOperation | null> {
  const id = z.string().uuid().parse(operationId).toLowerCase();
  const directory = path.join(authority.options.home, "workspace-retirements");
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  files.push(path.join("history", `${id}.json`));
  for (const file of files) {
    const journal = await readOptionalJournal(path.join(directory, file));
    if (!journal || journal.operationId !== id) continue;
    if (
      hashLayoutValue(journal.identity) !==
      hashLayoutValue(WorkspaceLayoutIdentitySchema.parse(authority.options.config))
    )
      throw new WorkspaceLayoutRefusal("retirement_operation_binding_changed");
    const reserve = journal.intents
      .flatMap((intent) => intent.mutations)
      .find((mutation) => mutation.kind === "reserve-retirement");
    if (
      !reserve ||
      reserve.kind !== "reserve-retirement" ||
      reserve.targets.length !== 1 ||
      reserve.ownerServerId !== authority.options.serverId
    )
      throw new WorkspaceLayoutRefusal("retirement_operation_scope_unavailable");
    const state = operationState(journal.result, journal.closedWithoutReservation, false);
    return WorkspaceRetirementOperationSchema.parse({
      operationId: id,
      workspaceId: reserve.targets[0].ref.workspaceId,
      ownerServerId: authority.options.serverId,
      state,
      terminal: state !== "partial",
      code:
        journal.result?.retirement?.code ??
        (state === "partial" ? "retirement_reconciliation_required" : null),
      backingGeneration: journal.backingGeneration,
      result: journal.result,
    });
  }
  return null;
}
/** Pure projection: never reconciles receipts, repairs a journal or authorizes an effect. */
export async function getWorkspaceRetirementStatus(
  authority: RetirementAuthority,
  operationId: string,
): Promise<WorkspaceRetirementOperation | null> {
  const record = await readCallerOperation(authority, operationId);
  if (!record) return unindexedOperation(authority, operationId);
  if (record.state !== "pending") return WorkspaceRetirementOperationSchema.parse(record);
  const journal = await callerJournal(authority, record);
  const result = journal?.result ?? null;
  const running = runningCallerOperations.has(operationFile(authority, operationId));
  const state = operationState(result, journal?.closedWithoutReservation ?? false, running);
  return WorkspaceRetirementOperationSchema.parse({
    ...record,
    state,
    terminal: state === "complete" || state === "refused",
    backingGeneration: journal?.backingGeneration ?? null,
    result,
    code: result?.retirement?.code ?? (!running ? "retirement_reconciliation_required" : null),
  });
}
function replayCallerOperation(record: WorkspaceRetirementOperation): RetirementResult {
  if (record.state === "refused" && !record.result)
    throw new WorkspaceLayoutRefusal(record.code ?? "retirement_refused");
  return record.result ?? partial(record.operationId, record.code ?? "retirement_in_progress");
}
function refusalCode(error: unknown): string {
  if (error instanceof WorkspaceLayoutRefusal) return error.code;
  if (error instanceof WorkspaceAutomationBlockedError) return "workspace_automation_blocked";
  if (error instanceof Error && /^[a-z][a-z0-9_]{1,127}$/.test(error.message)) return error.message;
  return "workspace_archive_failed";
}
export async function withCallerRetirementOperation(input: {
  authority: RetirementAuthority;
  operationId: string;
  workspaceId: string;
  getRecord: (id: string) => Promise<PersistedWorkspaceRecord | null>;
  run: (expectedNativeGeneration: string) => Promise<RetirementResult>;
}): Promise<RetirementResult> {
  const { authority, workspaceId } = input;
  const operationId = z.string().uuid().parse(input.operationId).toLowerCase();
  const file = operationFile(authority, operationId);
  async function replay() {
    const record = await getWorkspaceRetirementStatus(authority, operationId);
    if (record && record.workspaceId !== workspaceId)
      throw new WorkspaceLayoutRefusal("retirement_operation_id_conflict");
    return record ? replayCallerOperation(record) : null;
  }
  const existing = await replay();
  if (existing) return existing;
  return serializeWorkspaceBacking(
    {
      paths: [],
      keys: [
        nativeTransitionKey(
          authority.options.home,
          "workspace",
          `retirement-operation:${operationId}`,
        ),
      ],
    },
    async () => {
      const afterAcquisition = await replay();
      if (afterAcquisition) return afterAcquisition;
      const record: CallerOperation = {
        schemaVersion: 1,
        identity: WorkspaceLayoutIdentitySchema.parse(authority.options.config),
        ownerServerId: authority.options.serverId,
        operationId,
        workspaceId,
        nativeGeneration: null,
        backingGeneration: null,
        state: "pending",
        terminal: false,
        code: null,
        result: null,
      };
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const persist = () => writeFileDurably(file, `${JSON.stringify(record)}\n`);
      // This intent precedes even admission/hold checks, not only teardown.
      await persist();
      runningCallerOperations.add(file);
      try {
        if (
          (await authority.inspect()).retirements?.some(
            (operation) => operation.operationId === operationId,
          )
        )
          throw new WorkspaceLayoutRefusal("retirement_operation_id_conflict");
        const native = await input.getRecord(workspaceId);
        if (!native) throw new WorkspaceLayoutRefusal("workspace_not_found");
        record.nativeGeneration = nativeGeneration([native]);
        await persist();
        const result = await input.run(record.nativeGeneration);
        const journal = await callerJournal(authority, record);
        setCallerOutcome(record, journal, result);
        await persist();
        return result;
      } catch (error) {
        const journal = await callerJournal(authority, record);
        setCallerOutcome(record, journal, journal?.result ?? null, error);
        await persist();
        throw error;
      } finally {
        runningCallerOperations.delete(file);
      }
    },
  );
}

interface LiveHook {
  binding: WorkspaceRetirementBinding;
  verify: () => Promise<void>;
  active: boolean;
}
const liveHooks = new Map<string, LiveHook>();
function hookKey(home: string, binding: WorkspaceRetirementBinding): string {
  return `${path.resolve(home)}:${hashLayoutValue(binding)}`;
}
/** Only a synchronous, currently awaited hook may use this lease. Durable evidence is insufficient. */
export async function withWorkspaceRetirementHook<T>(
  input: { workspaceId: string | null; worktreePath: string; teardownCwd: string },
  run: (binding?: WorkspaceRetirementBinding) => Promise<T>,
): Promise<T> {
  const context = currentRetirement.getStore();
  if (!context) return run();
  if (!context.active || !input.workspaceId || !context.workspaceIds.has(input.workspaceId))
    throw new WorkspaceLayoutRefusal("retirement_hook_not_active");
  const binding = WorkspaceRetirementBindingSchema.parse({
    ...input,
    operationId: context.operationId,
    backingGeneration: context.backingGeneration,
  });
  await context.verifyHook(binding);
  const entry: LiveHook = { binding, active: true, verify: () => context.verifyHook(binding) };
  const key = hookKey(context.home, binding);
  if (liveHooks.has(key)) throw new WorkspaceLayoutRefusal("retirement_hook_already_active");
  liveHooks.set(key, entry);
  try {
    return await run(binding);
  } finally {
    entry.active = false;
    liveHooks.delete(key);
  }
}
export async function verifyWorkspaceRetirementBinding(
  home: string,
  input: WorkspaceRetirementBinding,
): Promise<{ valid: boolean; code: string | null }> {
  const binding = WorkspaceRetirementBindingSchema.parse(input);
  const key = hookKey(home, binding),
    entry = liveHooks.get(key);
  if (!entry?.active) return { valid: false, code: "retirement_hook_not_active" };
  try {
    // No reacquisition: the archive already holds the backing fence while awaiting its hook.
    await entry.verify();
    if (!entry.active || liveHooks.get(key) !== entry)
      return { valid: false, code: "retirement_hook_not_active" };
    return { valid: true, code: null };
  } catch (error) {
    return { valid: false, code: refusalCode(error) };
  }
}
