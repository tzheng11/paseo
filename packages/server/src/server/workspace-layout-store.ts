import {
  parseCapturedJson,
  validateCapturedValue,
  type CapturedJson,
  type ParsedCapture,
} from "./captured-json.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileDurably } from "./atomic-file.js";
import {
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutIdentitySchema,
  WorkspaceLayoutConfigSchema,
  WorkspaceLayoutHomeMarkerSchema,
  type WorkspaceLayoutConfig,
  WorkspaceLayoutReceiptSchema,
  WorkspaceLayoutReceiptRequestSchema,
  WorkspaceLayoutSnapshotSchema,
  canonicalLayoutJson,
  parseWorkspaceNavigationKey,
  workspaceReferenceKey,
  type WorkspaceLayoutCommit,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutIdentity,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutReceipt,
  type WorkspaceLayoutSnapshot,
  type EffectiveWorkspaceLayout,
  workspaceLayoutParentKey,
  resolveEffectiveWorkspaceLayout,
} from "@getpaseo/protocol/workspace-layout";
export { canonicalLayoutJson } from "@getpaseo/protocol/workspace-layout";

const StoreSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(3), z.literal(4), z.literal(5)]),
    snapshot: WorkspaceLayoutSnapshotSchema,
    receipts: z.record(z.string().regex(/^[a-f0-9]{64}$/), WorkspaceLayoutReceiptSchema),
  })
  .refine(
    (file) =>
      file.schemaVersion >= 4 === (file.snapshot.semanticsVersion === 2) &&
      (file.schemaVersion === 5) === (file.snapshot.retirementVersion === 1),
    "layout_semantics_format_mismatch",
  );
type StoreFile = z.infer<typeof StoreSchema>;
const GuardSchema = WorkspaceLayoutIdentitySchema.extend({
  schemaVersion: z.literal(1),
  initialized: z.boolean(),
});

export class WorkspaceLayoutRefusal extends Error {
  constructor(
    readonly code: string,
    diagnostic?: string,
  ) {
    super(`Workspace layout refused: ${code}${diagnostic ? `; ${diagnostic}` : ""}`);
    this.name = "WorkspaceLayoutRefusal";
  }
}

export function isRetirementConflictDiagnostic(message: string): boolean {
  return /^Workspace layout refused: retirement_conflict; operation=[a-f0-9-]{36}; target=[A-Za-z0-9_%.-]+\/[A-Za-z0-9_%.-]+$/.test(
    message,
  );
}

export interface CapturedWorkspaceLayoutInput {
  serverId: string;
  configured: WorkspaceLayoutConfig | undefined;
  marker: CapturedJson;
  store: CapturedJson;
  guard: CapturedJson;
  replica: CapturedJson;
}

/** Pure DOWN-state inspection; no filesystem calls, locking, initialization or authority contact.
 * A cached replica is only a replica, never a fresh authority or a source of commit receipts.
 */
export function parseCapturedWorkspaceLayout(input: CapturedWorkspaceLayoutInput) {
  const marker = parseCapturedJson(input.marker, WorkspaceLayoutHomeMarkerSchema);
  const store = parseCapturedJson(input.store, StoreSchema);
  const guard = parseCapturedJson(input.guard, GuardSchema);
  const replica = parseCapturedJson(input.replica, WorkspaceLayoutSnapshotSchema);
  const mode = resolveCapturedMode({ configured: input.configured, marker });
  if (!mode) {
    if ([store, guard, replica].some((file) => file.state === "present"))
      throw new WorkspaceLayoutRefusal("unconfigured_layout_data");
    return { role: "legacy" as const };
  }
  const identity = (value: WorkspaceLayoutIdentity) => {
    if (
      value.authorityServerId !== mode.authorityServerId ||
      value.authorityId !== mode.authorityId ||
      value.epoch !== mode.epoch
    )
      throw new WorkspaceLayoutRefusal("authority_identity_mismatch");
  };
  if (mode.role === "replica") {
    if (input.serverId === mode.authorityServerId)
      throw new WorkspaceLayoutRefusal("replica_is_authority");
    if (store.state === "present" || guard.state === "present")
      throw new WorkspaceLayoutRefusal("layout_role_data_mismatch");
    if (replica.state === "present") {
      identity(replica.value.stamp);
      if (replica.value.semanticsVersion !== mode.semanticsVersion)
        throw new WorkspaceLayoutRefusal("layout_semantics_mismatch");
      validateCapturedSnapshot(replica.value);
    }
    return { role: "replica" as const, mode, marker, cache: replica };
  }
  if (input.serverId !== mode.authorityServerId)
    throw new WorkspaceLayoutRefusal("authority_server_mismatch");
  if (replica.state === "present") throw new WorkspaceLayoutRefusal("layout_role_data_mismatch");
  if (guard.state === "present") identity(guard.value);
  if (store.state === "absent") {
    if (guard.state === "present" && guard.value.initialized)
      throw new WorkspaceLayoutRefusal("restore_authority_store");
    return {
      role: "authority" as const,
      state: "uninitialized" as const,
      mode,
      marker,
      guard: guard.state === "present" ? guard.value : null,
    };
  }
  if (guard.state !== "present" || !guard.value.initialized)
    throw new WorkspaceLayoutRefusal("initialized_guard_required");
  identity(store.value.snapshot.stamp);
  if (store.value.snapshot.semanticsVersion !== mode.semanticsVersion)
    throw new WorkspaceLayoutRefusal("layout_semantics_mismatch");
  validateCapturedSnapshot(store.value.snapshot);
  validateCapturedReceipts(store.value);
  validateInitialCapturedLayout(store.value);
  return {
    role: "authority" as const,
    state: "initialized" as const,
    mode,
    marker,
    guard: guard.value,
    store: store.value,
  };
}

function resolveCapturedMode(input: {
  configured: WorkspaceLayoutConfig | undefined;
  marker: ParsedCapture<z.infer<typeof WorkspaceLayoutHomeMarkerSchema>>;
}): WorkspaceLayoutConfig | undefined {
  const configured =
    input.configured === undefined
      ? undefined
      : validateCapturedValue(input.configured, WorkspaceLayoutConfigSchema);
  let mode = configured;
  if (input.marker.state === "present") {
    const {
      schemaVersion: _version,
      destructiveRetirement: _retirement,
      ...bound
    } = input.marker.value;
    if (configured && canonicalLayoutJson(configured) !== canonicalLayoutJson(bound))
      throw new WorkspaceLayoutRefusal("home_authority_binding_changed");
    mode = bound;
  }
  if (mode?.semanticsVersion === 2 && input.marker.state !== "present")
    throw new WorkspaceLayoutRefusal("derived_layout_marker_required");
  return mode;
}

function requireCapturedIdentity(
  value: WorkspaceLayoutIdentity,
  expected: WorkspaceLayoutIdentity,
): void {
  if (
    value.authorityServerId !== expected.authorityServerId ||
    value.authorityId !== expected.authorityId ||
    value.epoch !== expected.epoch
  )
    throw new WorkspaceLayoutRefusal("authority_identity_mismatch");
}

function validateCapturedReceipts(file: StoreFile): void {
  const current = file.snapshot.stamp;
  const receipts = Object.entries(file.receipts);
  if (receipts.length !== current.revision)
    throw new WorkspaceLayoutRefusal("incomplete_commit_receipts");
  const revisions = new Map<number, WorkspaceLayoutReceipt>();
  for (const [key, receipt] of receipts) {
    requireCapturedIdentity(receipt.stamp, current);
    if (
      !receipt.requestId ||
      receipt.requestId.length > 256 ||
      key !== receiptKey(receipt.requestId) ||
      receipt.stamp.revision < 1 ||
      receipt.stamp.revision > current.revision ||
      revisions.has(receipt.stamp.revision)
    )
      throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
    revisions.set(receipt.stamp.revision, receipt);
  }
  let active = false;
  for (let revision = 1; revision <= current.revision; revision++) {
    const receipt = revisions.get(revision);
    if (!receipt || (active && receipt.stamp.phase !== "active"))
      throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
    active ||= receipt.stamp.phase === "active";
  }
  if (
    current.revision > 0 &&
    canonicalLayoutJson(revisions.get(current.revision)?.stamp) !== canonicalLayoutJson(current)
  )
    throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
}

function validateInitialCapturedLayout(file: StoreFile): void {
  const current = file.snapshot.stamp;
  if (
    current.revision === 0 &&
    (current.phase !== "importing" ||
      file.snapshot.entries.length ||
      file.snapshot.imports.length ||
      file.snapshot.clientImports?.length ||
      file.snapshot.ownerDomains?.length ||
      file.snapshot.navigation !== null)
  )
    throw new WorkspaceLayoutRefusal("invalid_initial_layout");
}

function validateCapturedSnapshot(snapshot: WorkspaceLayoutSnapshot): void {
  // Format 3 always persists these fields. Wire compatibility optionality is not evidence of absence.
  if (!Object.hasOwn(snapshot, "clientImports") || !Object.hasOwn(snapshot, "navigation"))
    throw new WorkspaceLayoutRefusal("incomplete_layout_provenance");
  if (new Set(snapshot.imports.map((source) => source.serverId)).size !== snapshot.imports.length)
    throw new WorkspaceLayoutRefusal("duplicate_import_source");
  const sources = (snapshot.clientImports ?? []).map((entry) => entry.source.sourceId);
  if (new Set(sources).size !== sources.length)
    throw new WorkspaceLayoutRefusal("duplicate_client_source");
  // Navigation has its own counter: a commit may contain several navigation mutations.
  if (snapshot.entries.some((entry) => entry.revision > snapshot.stamp.revision))
    throw new WorkspaceLayoutRefusal("invalid_layout_revision");
  if (snapshot.ownerDomains?.some((domain) => domain.revision > snapshot.stamp.revision))
    throw new WorkspaceLayoutRefusal("invalid_owner_domain_revision");
  validateLayoutGraph(snapshot);
}

export interface WorkspaceLayoutStoreOptions {
  paseoHome: string;
  identity: WorkspaceLayoutIdentity;
  serverId: string;
  semanticsVersion?: 2;
  write?: (file: string, value: unknown) => Promise<void>;
}

/** The sole canonical writer. A missing or corrupt initialized store never becomes empty. */
export class WorkspaceLayoutStore {
  private readonly filePath: string;
  private readonly guardPath: string;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly write: NonNullable<WorkspaceLayoutStoreOptions["write"]>;
  private readonly identity: WorkspaceLayoutIdentity;

  constructor(private readonly options: WorkspaceLayoutStoreOptions) {
    this.identity = WorkspaceLayoutIdentitySchema.parse(options.identity);
    if (options.serverId !== options.identity.authorityServerId)
      throw new WorkspaceLayoutRefusal("authority_server_mismatch");
    this.filePath = path.join(options.paseoHome, "workspace-layout.json");
    this.guardPath = path.join(options.paseoHome, "workspace-layout-initialized.json");
    this.write = options.write ?? writeLayoutFileDurably;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async inspect(): Promise<WorkspaceLayoutSnapshot> {
    return this.exclusive(async () => structuredClone((await this.read()).snapshot));
  }

  async findReceipt(mutationRequestId: string): Promise<WorkspaceLayoutReceipt | null> {
    const id = WorkspaceLayoutReceiptRequestSchema.shape.mutationRequestId.parse(mutationRequestId);
    return this.exclusive(async () => {
      const current = await this.read();
      const receipt = current.receipts[receiptKey(id)];
      if (receipt && receipt.requestId !== id)
        throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
      return receipt ? structuredClone(receipt) : null;
    });
  }

  async initialize(identity: WorkspaceLayoutIdentity): Promise<WorkspaceLayoutSnapshot> {
    this.requireIdentity(identity);
    return this.exclusive(async () => {
      const guard = await this.readGuard();
      try {
        return structuredClone((await this.read()).snapshot);
      } catch (error) {
        if (!(error instanceof WorkspaceLayoutRefusal) || error.code !== "not_initialized")
          throw error;
      }
      if (guard?.initialized) throw new WorkspaceLayoutRefusal("restore_authority_store");
      // Persist intent before data. If initialization fails, inspect refuses;
      // it never exposes a partial successful import or an active empty layout.
      await this.write(this.guardPath, {
        schemaVersion: 1,
        ...this.identity,
        initialized: false,
      });
      const file: StoreFile = {
        schemaVersion: this.options.semanticsVersion === 2 ? 4 : 3,
        snapshot: {
          ...(this.options.semanticsVersion === 2
            ? { semanticsVersion: 2 as const, ownerDomains: [] }
            : {}),
          stamp: { ...this.identity, revision: 0, phase: "importing" },
          entries: [],
          imports: [],
          clientImports: [],
          navigation: null,
        },
        receipts: {},
      };
      await this.write(this.filePath, file);
      await this.markInitialized();
      return structuredClone(file.snapshot);
    });
  }

  async commit(raw: WorkspaceLayoutCommit): Promise<WorkspaceLayoutReceipt> {
    const input = WorkspaceLayoutCommitSchema.parse(raw);
    this.requireIdentity(input.expected);
    const hash = hashLayoutValue(input);
    return this.exclusive(async () => {
      const current = await this.read();
      const key = receiptKey(input.requestId);
      const prior = current.receipts[key];
      if (prior) {
        if (prior.requestId !== input.requestId || prior.requestSha256 !== hash)
          throw new WorkspaceLayoutRefusal("request_id_conflict");
        return structuredClone(prior);
      }
      assertLayoutWriter(current.snapshot, input);
      if (canonicalLayoutJson(input.expected) !== canonicalLayoutJson(current.snapshot.stamp))
        throw new WorkspaceLayoutRefusal("stale_revision");
      if (input.expected.revision === Number.MAX_SAFE_INTEGER)
        throw new WorkspaceLayoutRefusal("revision_exhausted");
      const next = structuredClone(current);
      const revision = current.snapshot.stamp.revision + 1;
      for (const mutation of input.mutations) applyMutation(next.snapshot, mutation, revision);
      if (next.snapshot.retirementVersion === 1) next.schemaVersion = 5;
      validateNewNavigationParents(current.snapshot, next.snapshot, input.mutations);
      next.snapshot.stamp.revision = revision;
      validateLayoutGraph(next.snapshot);
      const receipt: WorkspaceLayoutReceipt = {
        requestId: input.requestId,
        requestSha256: hash,
        stamp: structuredClone(next.snapshot.stamp),
      };
      next.receipts[key] = receipt;
      await this.write(this.filePath, StoreSchema.parse(next));
      // The idempotent receipt is durable even if publication fails afterwards.
      for (const listener of this.listeners) listener();
      return structuredClone(receipt);
    });
  }

  private requireIdentity(identity: WorkspaceLayoutIdentity): void {
    const expected = this.identity;
    if (
      identity.authorityServerId !== expected.authorityServerId ||
      identity.authorityId !== expected.authorityId ||
      identity.epoch !== expected.epoch
    )
      throw new WorkspaceLayoutRefusal("authority_identity_mismatch");
  }

  private async readGuard() {
    try {
      const guard = GuardSchema.parse(JSON.parse(await readFile(this.guardPath, "utf8")));
      this.requireIdentity(guard);
      return guard;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return null;
    }
  }

  private async markInitialized(): Promise<void> {
    await this.write(this.guardPath, {
      schemaVersion: 1,
      ...this.identity,
      initialized: true,
    });
  }

  private async read(): Promise<StoreFile> {
    const guard = await this.readGuard();
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      throw new WorkspaceLayoutRefusal(
        guard?.initialized ? "restore_authority_store" : "not_initialized",
      );
    }
    const file = StoreSchema.parse(JSON.parse(text));
    if (file.snapshot.semanticsVersion !== this.options.semanticsVersion)
      throw new WorkspaceLayoutRefusal("layout_semantics_migration_required");
    this.requireIdentity(file.snapshot.stamp);
    validateLayoutGraph(file.snapshot);
    if (!guard?.initialized) await this.markInitialized();
    return file;
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await mkdir(this.options.paseoHome, { recursive: true });
      const lock = `${this.filePath}.lock`;
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new WorkspaceLayoutRefusal("authority_busy");
        throw error;
      }
      try {
        return await run();
      } finally {
        await rmdir(lock);
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function applyMutation(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: WorkspaceLayoutMutation,
  revision: number,
) {
  assertRetirementMutationAllowed(snapshot, mutation);
  switch (mutation.kind) {
    case "reserve-retirement":
      return reserveRetirement(snapshot, mutation, revision);
    case "archive-retirement":
    case "complete-retirement":
      return advanceRetirement(snapshot, mutation, revision);
    case "declare-unknown-owner": {
      if (snapshot.semanticsVersion !== 2 || snapshot.stamp.phase !== "importing")
        throw new WorkspaceLayoutRefusal("owner_declaration_closed");
      if (snapshot.ownerDomains?.some((domain) => domain.serverId === mutation.serverId))
        throw new WorkspaceLayoutRefusal("owner_already_declared");
      snapshot.ownerDomains!.push({ serverId: mutation.serverId, state: "unknown", revision });
      return;
    }
    case "put":
      return putLayoutEntry(snapshot, mutation, revision);
    case "import-host":
      return importLayoutHost(snapshot, mutation, revision);
    case "activate":
      return activateLayout(snapshot, mutation);
    case "import-client":
      return importLayoutClient(snapshot, mutation);
    case "put-navigation":
      return putNavigation(snapshot, mutation);
  }
}

function putLayoutEntry(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "put" }>,
  revision: number,
) {
  if (snapshot.stamp.phase !== "active") throw new WorkspaceLayoutRefusal("layout_importing");
  const key = workspaceReferenceKey(mutation.entry.ref);
  const index = snapshot.entries.findIndex((entry) => workspaceReferenceKey(entry.ref) === key);
  const prior = index < 0 ? null : snapshot.entries[index];
  if (snapshot.semanticsVersion === 2) validateDerivedPut(snapshot, mutation.entry, prior);
  if ((prior?.revision ?? 0) !== mutation.entry.revision)
    throw new WorkspaceLayoutRefusal("stale_entry_revision");
  const next = { ...mutation.entry, revision };
  if (index < 0) snapshot.entries.push(next);
  else snapshot.entries[index] = next;
  return;
}

function assertOwnerAdmission(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "import-host" }>,
): void {
  const domain = snapshot.ownerDomains?.find((item) => item.serverId === mutation.source.serverId);
  if (snapshot.stamp.phase !== "importing") {
    const joiningUnknown =
      snapshot.semanticsVersion === 2 &&
      domain?.state === "unknown" &&
      domain.revision === mutation.expectedDomainRevision &&
      mutation.previousSourceSha256 === null &&
      !snapshot.imports.some((source) => source.serverId === mutation.source.serverId) &&
      !snapshot.entries.some((entry) => entry.ref.serverId === mutation.source.serverId);
    if (!joiningUnknown) throw new WorkspaceLayoutRefusal("import_closed");
  }
}

function importLayoutHost(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "import-host" }>,
  revision: number,
) {
  assertOwnerAdmission(snapshot, mutation);
  const previous = snapshot.imports.find((source) => source.serverId === mutation.source.serverId);
  if ((previous?.sourceSha256 ?? null) !== mutation.previousSourceSha256)
    throw new WorkspaceLayoutRefusal("stale_import_source");
  if (mutation.entries.some((entry) => entry.ref.serverId !== mutation.source.serverId))
    throw new WorkspaceLayoutRefusal("import_host_mismatch");
  const old = snapshot.entries.filter((entry) => entry.ref.serverId === mutation.source.serverId);
  const keys = new Set(mutation.entries.map((entry) => workspaceReferenceKey(entry.ref)));
  if (old.some((entry) => !keys.has(workspaceReferenceKey(entry.ref))))
    throw new WorkspaceLayoutRefusal("import_drops_existing_workspace");
  snapshot.entries = snapshot.entries.filter(
    (entry) => entry.ref.serverId !== mutation.source.serverId,
  );
  snapshot.entries.push(...mutation.entries.map((entry) => Object.assign({}, entry, { revision })));
  snapshot.imports = snapshot.imports.filter(
    (source) => source.serverId !== mutation.source.serverId,
  );
  snapshot.imports.push(mutation.source);
  if (snapshot.semanticsVersion === 2) {
    for (const entry of mutation.entries) {
      if (
        !entry.sectionIntent ||
        entry.sectionIntent.baselineSection !== layoutSection(entry) ||
        (entry.sectionIntent.mode === "legacy" &&
          entry.sectionIntent.baselineParentWorkspaceKey !== workspaceLayoutParentKey(entry))
      )
        throw new WorkspaceLayoutRefusal("unqualified_section_baseline");
    }
    snapshot.ownerDomains = (snapshot.ownerDomains ?? []).filter(
      (item) => item.serverId !== mutation.source.serverId,
    );
    snapshot.ownerDomains.push({ serverId: mutation.source.serverId, state: "adopted", revision });
  }
  return;
}

function activateLayout(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "activate" }>,
) {
  if (snapshot.stamp.phase !== "importing") throw new WorkspaceLayoutRefusal("already_active");
  if (
    snapshot.semanticsVersion === 2 &&
    canonicalLayoutJson(mutation.requiredOwnerDomains) !==
      canonicalLayoutJson(snapshot.ownerDomains)
  )
    throw new WorkspaceLayoutRefusal("owner_manifest_mismatch");
  const required = new Set(mutation.requiredImports.map((source) => source.serverId));
  if (
    required.size !== mutation.requiredImports.length ||
    required.size !== snapshot.imports.length ||
    mutation.requiredImports.some(
      (source) =>
        !snapshot.imports.some(
          (imported) => canonicalLayoutJson(imported) === canonicalLayoutJson(source),
        ),
    )
  )
    throw new WorkspaceLayoutRefusal("import_manifest_mismatch");
  assertClientSources(
    mutation.requiredClientImports ?? [],
    (snapshot.clientImports ?? []).map((input) => input.source),
  );
  snapshot.stamp.phase = "active";
  return;
}

function importLayoutClient(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "import-client" }>,
) {
  if (snapshot.stamp.phase !== "importing") throw new WorkspaceLayoutRefusal("import_closed");
  const clients = snapshot.clientImports ?? [];
  const prior = clients.find((input) => input.source.sourceId === mutation.input.source.sourceId);
  if ((prior?.source.sourceSha256 ?? null) !== mutation.previousSourceSha256)
    throw new WorkspaceLayoutRefusal("stale_client_import_source");
  snapshot.clientImports = clients.filter(
    (input) => input.source.sourceId !== mutation.input.source.sourceId,
  );
  snapshot.clientImports.push(mutation.input);
  return;
}

function putNavigation(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "put-navigation" }>,
) {
  const prior = snapshot.navigation;
  if ((prior?.revision ?? 0) !== mutation.expectedRevision)
    throw new WorkspaceLayoutRefusal("stale_navigation_revision");
  let resolution = prior;
  if (snapshot.stamp.phase === "importing") {
    if (!mutation.importResolution)
      throw new WorkspaceLayoutRefusal("navigation_import_resolution_required");
    assertClientSources(
      mutation.importResolution.clientSources,
      (snapshot.clientImports ?? []).map((input) => input.source),
    );
    resolution = {
      revision: 0,
      preferences: mutation.preferences,
      ...mutation.importResolution,
    };
  } else if (!resolution || mutation.importResolution) {
    throw new WorkspaceLayoutRefusal("navigation_import_closed");
  }
  snapshot.navigation = {
    ...resolution,
    revision: (prior?.revision ?? 0) + 1,
    preferences: mutation.preferences,
  };
  return;
}

function assertClientSources(
  expected: NonNullable<WorkspaceLayoutSnapshot["navigation"]>["clientSources"],
  actual: NonNullable<WorkspaceLayoutSnapshot["navigation"]>["clientSources"],
): void {
  const byId = new Map(actual.map((source) => [source.sourceId, source]));
  if (
    byId.size !== actual.length ||
    new Set(expected.map((source) => source.sourceId)).size !== expected.length ||
    expected.length !== actual.length ||
    expected.some(
      (source) => canonicalLayoutJson(source) !== canonicalLayoutJson(byId.get(source.sourceId)),
    )
  )
    throw new WorkspaceLayoutRefusal("client_import_manifest_mismatch");
}

function layoutSection(entry: WorkspaceLayoutEntry): string {
  if (entry.superpinnedAt) return "superpinned";
  return entry.pinnedAt ? "pinned" : "unpinned";
}

function retirementKeys(entry: WorkspaceLayoutEntry): string[] {
  const keys: string[] = [];
  if (entry.parent) keys.push(workspaceReferenceKey(entry.parent));
  if (entry.pinPlacement?.parentWorkspaceKey)
    keys.push(
      workspaceReferenceKey(parseWorkspaceNavigationKey(entry.pinPlacement.parentWorkspaceKey)),
    );
  return keys;
}

function assertRetirementMutationAllowed(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: WorkspaceLayoutMutation,
): void {
  if (mutation.kind === "archive-retirement" || mutation.kind === "complete-retirement") return;
  const operations = snapshot.retirements ?? [];
  const targets = new Set(
    operations.flatMap((op) => op.targets.map((t) => workspaceReferenceKey(t.ref))),
  );
  const fenced = new Set(
    operations
      .filter((op) => op.state !== "complete")
      .flatMap((op) =>
        [...op.targets, ...op.dependencies].map((t) => workspaceReferenceKey(t.ref)),
      ),
  );
  const conflicts = (entry: WorkspaceLayoutEntry) => {
    const key = workspaceReferenceKey(entry.ref);
    return (
      targets.has(key) ||
      fenced.has(key) ||
      retirementKeys(entry).some((k) => targets.has(k) || fenced.has(k))
    );
  };
  const conflictError = (entry?: WorkspaceLayoutEntry) => {
    const keys = entry ? [workspaceReferenceKey(entry.ref), ...retirementKeys(entry)] : [...fenced];
    const op = operations.find((candidate) =>
      [
        ...candidate.targets,
        ...(candidate.state !== "complete" ? candidate.dependencies : []),
      ].some((row) => keys.includes(workspaceReferenceKey(row.ref))),
    );
    const ref = op?.targets[0]?.ref;
    const diagnostic =
      op && ref
        ? `operation=${op.operationId}; target=${encodeURIComponent(ref.serverId)}/${encodeURIComponent(ref.workspaceId)}`
        : undefined;
    return new WorkspaceLayoutRefusal("retirement_conflict", diagnostic);
  };
  if (
    mutation.kind === "put" &&
    snapshot.stamp.phase === "active" &&
    snapshot.semanticsVersion === 2
  ) {
    const prior = snapshot.entries.find(
      (row) => workspaceReferenceKey(row.ref) === workspaceReferenceKey(mutation.entry.ref),
    );
    if (prior && prior.archivedAt !== mutation.entry.archivedAt)
      throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  }
  if (mutation.kind === "put" && conflicts(mutation.entry)) throw conflictError(mutation.entry);
  if (mutation.kind === "import-host" && mutation.entries.some(conflicts))
    throw conflictError(mutation.entries.find(conflicts));
  if (mutation.kind === "put-navigation" && fenced.size) {
    const before = snapshot.navigation?.preferences;
    const after = mutation.preferences;
    // Ordering a reserved item is a conflicting layout write, even when its entry is unchanged.
    const positions = (preferences: typeof after | undefined) =>
      [...fenced].map((refKey) => {
        const [serverId, workspaceId] = JSON.parse(refKey);
        const key = `${serverId}:${workspaceId}`;
        const project = snapshot.entries.find(
          (entry) => workspaceReferenceKey(entry.ref) === refKey,
        )!.projectId;
        return [
          key,
          preferences?.workspaceSort,
          preferences?.projectOrder.indexOf(project),
          preferences?.workspaceSortModeByProject[project],
          preferences?.pinnedWorkspaceOrder.indexOf(key),
          preferences?.superpinnedWorkspaceOrder.indexOf(key),
          preferences?.pinnedWorkspaceSortMode,
          Object.entries(preferences?.workspaceOrderByProject ?? {}).flatMap(
            ([orderedProject, keys]) =>
              keys.includes(key)
                ? [
                    [
                      orderedProject,
                      keys.indexOf(key),
                      preferences?.workspaceSortModeByProject[orderedProject],
                    ],
                  ]
                : [],
          ),
        ];
      });
    if (canonicalLayoutJson(positions(before)) !== canonicalLayoutJson(positions(after)))
      throw conflictError();
  }
}

type RetirementReservation = Extract<WorkspaceLayoutMutation, { kind: "reserve-retirement" }>;
interface RetirementGraph {
  snapshot: WorkspaceLayoutSnapshot;
  input: RetirementReservation;
  entries: Map<string, WorkspaceLayoutEntry>;
  effective: Map<string, EffectiveWorkspaceLayout>;
}
function requireRetirementTarget(
  context: RetirementGraph,
  target: RetirementReservation["targets"][number],
): WorkspaceLayoutEntry {
  const { snapshot, input, entries, effective } = context;
  const entry = entries.get(workspaceReferenceKey(target.ref));
  if (
    target.ref.serverId !== input.ownerServerId ||
    !snapshot.ownerDomains?.some(
      (domain) => domain.serverId === target.ref.serverId && domain.state === "adopted",
    )
  )
    throw new WorkspaceLayoutRefusal("retirement_owner_unavailable");
  if (!entry || entry.archivedAt) throw new WorkspaceLayoutRefusal("retirement_target_unavailable");
  if (entry.revision !== target.revision)
    throw new WorkspaceLayoutRefusal("entry_revision_conflict");
  const section = effective.get(`${entry.ref.serverId}:${entry.ref.workspaceId}`)?.section;
  if (section == null) throw new WorkspaceLayoutRefusal("retirement_ancestry_unresolved");
  if (entry.pinnedAt || entry.superpinnedAt || section !== "unpinned")
    throw new WorkspaceLayoutRefusal("retirement_protected");
  return entry;
}
function collectRetirementAncestors(
  context: RetirementGraph,
  entry: WorkspaceLayoutEntry,
  dependencies: Map<string, WorkspaceLayoutEntry>,
): void {
  const pending = retirementKeys(entry);
  const visited = new Set<string>();
  while (pending.length) {
    const ancestorKey = pending.pop()!;
    if (visited.has(ancestorKey)) continue;
    visited.add(ancestorKey);
    const ancestor = context.entries.get(ancestorKey);
    if (
      !ancestor ||
      ancestor.archivedAt ||
      !context.snapshot.ownerDomains?.some(
        (domain) => domain.serverId === ancestor.ref.serverId && domain.state === "adopted",
      )
    )
      throw new WorkspaceLayoutRefusal("retirement_ancestry_unresolved");
    if (ancestor.ref.serverId !== context.input.ownerServerId)
      throw new WorkspaceLayoutRefusal("retirement_cross_owner_dependency");
    dependencies.set(ancestorKey, ancestor);
    pending.push(...retirementKeys(ancestor));
  }
}

function reserveRetirement(
  snapshot: WorkspaceLayoutSnapshot,
  input: Extract<WorkspaceLayoutMutation, { kind: "reserve-retirement" }>,
  revision: number,
): void {
  if (snapshot.semanticsVersion !== 2)
    throw new WorkspaceLayoutRefusal("retirement_semantics_required");
  if (snapshot.stamp.phase !== "active") throw new WorkspaceLayoutRefusal("layout_importing");
  const operations = snapshot.retirements ?? [];
  if (operations.some((op) => op.operationId === input.operationId))
    throw new WorkspaceLayoutRefusal("retirement_operation_conflict");
  const entries = new Map(
    snapshot.entries.map((entry) => [workspaceReferenceKey(entry.ref), entry]),
  );
  const keys = new Set(input.targets.map((target) => workspaceReferenceKey(target.ref)));
  if (keys.size !== input.targets.length)
    throw new WorkspaceLayoutRefusal("duplicate_retirement_target");
  const effective = resolveEffectiveWorkspaceLayout(snapshot);
  const dependencies = new Map<string, WorkspaceLayoutEntry>();
  const context = { snapshot, input, entries, effective };
  for (const target of input.targets) {
    const targetEntry = requireRetirementTarget(context, target);
    collectRetirementAncestors(context, targetEntry, dependencies);
  }
  for (const entry of entries.values()) {
    if (
      !entry.archivedAt &&
      !keys.has(workspaceReferenceKey(entry.ref)) &&
      retirementKeys(entry).some((key) => keys.has(key))
    )
      throw new WorkspaceLayoutRefusal("retirement_live_descendant");
  }
  const readKeys = new Set([...keys, ...dependencies.keys()]);
  if (
    operations.some(
      (op) =>
        op.state !== "complete" &&
        [...op.targets, ...op.dependencies].some((target) =>
          readKeys.has(workspaceReferenceKey(target.ref)),
        ),
    )
  )
    throw new WorkspaceLayoutRefusal("retirement_conflict");
  snapshot.retirementVersion = 1;
  snapshot.retirements = [
    ...operations,
    {
      operationId: input.operationId,
      ownerServerId: input.ownerServerId,
      backingGeneration: input.backingGeneration,
      targets: input.targets,
      dependencies: [...dependencies.values()].map((entry) => ({
        ref: entry.ref,
        revision: entry.revision,
      })),
      state: "reserved",
      reservedRevision: revision,
      archivedAt: null,
    },
  ];
}

function advanceRetirement(
  snapshot: WorkspaceLayoutSnapshot,
  input: Extract<WorkspaceLayoutMutation, { kind: "archive-retirement" | "complete-retirement" }>,
  revision: number,
): void {
  const operation = snapshot.retirements?.find((op) => op.operationId === input.operationId);
  if (!operation) throw new WorkspaceLayoutRefusal("retirement_not_reserved");
  if (input.kind === "archive-retirement") {
    if (operation.state !== "reserved")
      throw new WorkspaceLayoutRefusal("retirement_phase_conflict");
    for (const target of operation.targets) {
      const entry = snapshot.entries.find(
        (row) => workspaceReferenceKey(row.ref) === workspaceReferenceKey(target.ref),
      );
      if (!entry || entry.revision !== target.revision)
        throw new WorkspaceLayoutRefusal("entry_revision_conflict");
      entry.archivedAt = input.archivedAt;
      entry.revision = revision;
    }
    operation.archivedAt = input.archivedAt;
    operation.state = "archived";
  } else {
    if (operation.state !== "archived")
      throw new WorkspaceLayoutRefusal("retirement_phase_conflict");
    operation.state = "complete";
  }
}

function assertLayoutWriter(snapshot: WorkspaceLayoutSnapshot, input: WorkspaceLayoutCommit): void {
  if (
    (snapshot.retirementVersion === 1 ||
      input.mutations.some((m) => m.kind.endsWith("-retirement"))) &&
    input.writerVersion !== 3
  )
    throw new WorkspaceLayoutRefusal("retirement_writer_required");
  if (snapshot.semanticsVersion === 2 && input.writerVersion !== 2 && input.writerVersion !== 3)
    throw new WorkspaceLayoutRefusal("writer_version_required");
}

function validateOwnerDomains(snapshot: WorkspaceLayoutSnapshot): void {
  if (!snapshot.ownerDomains) throw new WorkspaceLayoutRefusal("owner_coverage_required");
  const domains = new Map(snapshot.ownerDomains.map((domain) => [domain.serverId, domain]));
  if (domains.size !== snapshot.ownerDomains.length)
    throw new WorkspaceLayoutRefusal("duplicate_owner_domain");
  for (const domain of domains.values()) {
    const imported = snapshot.imports.some((source) => source.serverId === domain.serverId);
    if (imported !== (domain.state === "adopted"))
      throw new WorkspaceLayoutRefusal("owner_import_mismatch");
  }
  for (const source of snapshot.imports)
    if (domains.get(source.serverId)?.state !== "adopted")
      throw new WorkspaceLayoutRefusal("owner_import_mismatch");
  for (const entry of snapshot.entries) {
    if (domains.get(entry.ref.serverId)?.state !== "adopted")
      throw new WorkspaceLayoutRefusal("owner_not_adopted");
    if (!entry.sectionIntent) throw new WorkspaceLayoutRefusal("section_intent_required");
    if (entry.sectionIntent.mode === "inherit" && workspaceLayoutParentKey(entry) === null)
      throw new WorkspaceLayoutRefusal("inheritance_requires_parent");
  }
}

function validateDerivedPut(
  snapshot: WorkspaceLayoutSnapshot,
  entry: WorkspaceLayoutEntry,
  prior: WorkspaceLayoutEntry | null,
): void {
  if (
    snapshot.ownerDomains?.find((domain) => domain.serverId === entry.ref.serverId)?.state !==
    "adopted"
  )
    throw new WorkspaceLayoutRefusal("owner_not_adopted");
  const intent = entry.sectionIntent;
  if (!intent) throw new WorkspaceLayoutRefusal("section_intent_required");
  if (
    prior?.sectionIntent &&
    (intent.baselineSection !== prior.sectionIntent.baselineSection ||
      intent.baselineParentWorkspaceKey !== prior.sectionIntent.baselineParentWorkspaceKey)
  )
    throw new WorkspaceLayoutRefusal("section_baseline_changed");
  if (intent.mode === "inherit" && workspaceLayoutParentKey(entry) === null)
    throw new WorkspaceLayoutRefusal("inheritance_requires_parent");
  if (
    prior &&
    workspaceLayoutParentKey(prior) !== workspaceLayoutParentKey(entry) &&
    intent.mode === "legacy"
  )
    throw new WorkspaceLayoutRefusal("explicit_section_intent_required");
}

function assertKnownParentChain(
  key: string | null,
  entries: Map<string, WorkspaceLayoutEntry>,
  movingKey: string,
): void {
  const visited = new Set([movingKey]);
  let current = key;
  while (current !== null) {
    if (visited.has(current)) throw new WorkspaceLayoutRefusal("workspace_layout_cycle");
    visited.add(current);
    const entry = entries.get(current);
    if (!entry || entry.archivedAt)
      throw new WorkspaceLayoutRefusal(`required_parent_unavailable:${current}`);
    current = workspaceLayoutParentKey(entry);
  }
}

/** A durable receipt plus its exact CAS input can advance a known full snapshot without another read. */
export function projectConfirmedLayout(
  snapshot: WorkspaceLayoutSnapshot,
  input: WorkspaceLayoutCommit,
  receipt: WorkspaceLayoutReceipt,
): WorkspaceLayoutSnapshot | null {
  if (canonicalLayoutJson(snapshot.stamp) !== canonicalLayoutJson(input.expected)) return null;
  assertLayoutWriter(snapshot, input);
  const next = structuredClone(snapshot);
  const revision = snapshot.stamp.revision + 1;
  for (const mutation of input.mutations) applyMutation(next, mutation, revision);
  validateNewNavigationParents(snapshot, next, input.mutations);
  next.stamp.revision = revision;
  validateLayoutGraph(next);
  if (canonicalLayoutJson(next.stamp) !== canonicalLayoutJson(receipt.stamp))
    throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
  return next;
}

function validateRetirementState(snapshot: WorkspaceLayoutSnapshot): void {
  if (
    (snapshot.retirementVersion === 1) !==
    (snapshot.retirements !== undefined && snapshot.retirements.length > 0)
  )
    throw new WorkspaceLayoutRefusal("retirement_format_mismatch");
  const operationIds = new Set<string>();
  const retiredKeys = new Set<string>();
  for (const operation of snapshot.retirements ?? []) {
    if (
      operationIds.has(operation.operationId) ||
      operation.reservedRevision > snapshot.stamp.revision
    )
      throw new WorkspaceLayoutRefusal("invalid_retirement_operation");
    operationIds.add(operation.operationId);
    for (const target of operation.targets) {
      const key = workspaceReferenceKey(target.ref);
      if (retiredKeys.has(key) || target.ref.serverId !== operation.ownerServerId)
        throw new WorkspaceLayoutRefusal("invalid_retirement_target");
      retiredKeys.add(key);
      const entry = snapshot.entries.find((row) => workspaceReferenceKey(row.ref) === key);
      if (
        !entry ||
        (operation.state === "reserved" &&
          (entry.revision !== target.revision || entry.archivedAt !== null)) ||
        (operation.state !== "reserved" &&
          (!operation.archivedAt || entry.archivedAt !== operation.archivedAt))
      )
        throw new WorkspaceLayoutRefusal("retirement_tombstone_mismatch");
    }
  }
}

export function validateLayoutGraph(snapshot: WorkspaceLayoutSnapshot): void {
  validateRetirementState(snapshot);
  if (snapshot.semanticsVersion === 2) validateOwnerDomains(snapshot);
  else if (
    snapshot.ownerDomains !== undefined ||
    snapshot.entries.some((entry) => entry.sectionIntent !== undefined)
  )
    throw new WorkspaceLayoutRefusal("layout_semantics_not_enabled");
  const entries = new Map<string, WorkspaceLayoutEntry>();
  for (const entry of snapshot.entries) {
    const key = workspaceReferenceKey(entry.ref);
    if (entries.has(key)) throw new WorkspaceLayoutRefusal("duplicate_workspace_identity");
    if (entry.superpinnedAt !== null && entry.pinnedAt === null)
      throw new WorkspaceLayoutRefusal("orphan_superpin");
    entries.set(key, entry);
  }
  const structural = new Map<string, string | null>();
  const navigation = new Map<string, string | null>();
  const unknown = new Set(
    snapshot.ownerDomains
      ?.filter((domain) => domain.state === "unknown")
      .map((domain) => domain.serverId),
  );
  for (const [key, entry] of entries) {
    const parent = structuralParent(entry, entries, snapshot.stamp.phase, unknown);
    structural.set(key, parent ? workspaceReferenceKey(parent.ref) : null);
    const placement = navigationParent(entry, parent, entries, snapshot.stamp.phase, unknown);
    navigation.set(key, placement ? workspaceReferenceKey(placement.ref) : null);
  }
  assertAcyclic(structural);
  assertAcyclic(navigation);
  validateNavigation(snapshot, entries);
  if (snapshot.semanticsVersion === 2) resolveEffectiveWorkspaceLayout(snapshot);
}

function validateNavigation(
  snapshot: WorkspaceLayoutSnapshot,
  entries: Map<string, WorkspaceLayoutEntry>,
): void {
  if (snapshot.stamp.phase === "active") {
    if (!snapshot.navigation) throw new WorkspaceLayoutRefusal("navigation_not_resolved");
    if (!snapshot.navigation.preferences.workspaceSort)
      throw new WorkspaceLayoutRefusal("global_sort_not_resolved");
    assertClientSources(
      snapshot.navigation.clientSources,
      (snapshot.clientImports ?? []).map((input) => input.source),
    );
  }
  const unique = (keys: string[]) => {
    if (new Set(keys).size !== keys.length)
      throw new WorkspaceLayoutRefusal("duplicate_navigation_reference");
  };
  const validate = (
    preferences: NonNullable<WorkspaceLayoutSnapshot["navigation"]>["preferences"],
  ) => {
    unique(preferences.projectOrder);
    const orders = [
      preferences.pinnedWorkspaceOrder,
      preferences.superpinnedWorkspaceOrder,
      ...Object.values(preferences.workspaceOrderByProject),
    ];
    for (const keys of orders) {
      unique(keys);
      for (const key of keys)
        findParent(
          parseWorkspaceNavigationKey(key),
          entries,
          snapshot.stamp.phase,
          new Set(
            snapshot.ownerDomains
              ?.filter((domain) => domain.state === "unknown")
              .map((domain) => domain.serverId),
          ),
        );
    }
  };
  if (snapshot.navigation) validate(snapshot.navigation.preferences);
  // Retained client imports are provenance, including obsolete/dormant refs.
  // Only explicitly resolved navigation and entry links affect the live view.
}

function structuralParent(
  entry: WorkspaceLayoutEntry,
  entries: Map<string, WorkspaceLayoutEntry>,
  phase: string,
  unknownOwners?: ReadonlySet<string>,
) {
  if (!entry.parent) return null;
  if (entry.parent.serverId !== entry.ref.serverId)
    throw new WorkspaceLayoutRefusal("structural_parent_host_mismatch");
  const parent = findParent(entry.parent, entries, phase, unknownOwners);
  if (parent && parent.projectId !== entry.projectId)
    throw new WorkspaceLayoutRefusal("structural_parent_project_mismatch");
  return parent;
}

function navigationParent(
  entry: WorkspaceLayoutEntry,
  structural: WorkspaceLayoutEntry | null,
  entries: Map<string, WorkspaceLayoutEntry>,
  phase: string,
  unknownOwners?: ReadonlySet<string>,
) {
  if (!entry.pinPlacement) {
    // Validate stored edges, including dormant ones, so later reactivation
    // cannot reveal a cycle. Visible eligibility belongs to the UI projection.
    return structural;
  }
  const key = entry.pinPlacement.parentWorkspaceKey;
  if (key === null) return null;
  const parent = findParent(parseWorkspaceNavigationKey(key), entries, phase, unknownOwners);
  return parent;
}

function validateNewNavigationParents(
  previous: WorkspaceLayoutSnapshot,
  next: WorkspaceLayoutSnapshot,
  mutations: WorkspaceLayoutMutation[],
): void {
  const before = new Map(
    previous.entries.map((entry) => [workspaceReferenceKey(entry.ref), entry]),
  );
  const after = new Map(next.entries.map((entry) => [workspaceReferenceKey(entry.ref), entry]));
  const navigationEntries = new Map(
    next.entries.map((entry) => [`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry]),
  );
  const effective = next.semanticsVersion === 2 ? resolveEffectiveWorkspaceLayout(next) : null;
  const priorNavigationEntries = new Map(
    previous.entries.map((entry) => [`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry]),
  );
  for (const mutation of mutations) {
    if (mutation.kind !== "put") continue;
    const entry = mutation.entry;
    if (next.semanticsVersion === 2)
      assertDerivedMoveAncestry(
        before.get(workspaceReferenceKey(entry.ref)),
        entry,
        priorNavigationEntries,
        navigationEntries,
      );
    const parentKey = entry.pinPlacement?.parentWorkspaceKey;
    if (
      parentKey == null ||
      before.get(workspaceReferenceKey(entry.ref))?.pinPlacement?.parentWorkspaceKey === parentKey
    )
      continue;
    const parent = findParent(parseWorkspaceNavigationKey(parentKey), after, next.stamp.phase);
    if (
      parent &&
      (parent.archivedAt ||
        entry.archivedAt ||
        (effective
          ? effective.get(parentKey)?.section !==
            effective.get(`${entry.ref.serverId}:${entry.ref.workspaceId}`)?.section
          : layoutSection(parent) !== layoutSection(entry)))
    )
      throw new WorkspaceLayoutRefusal("parent_section_mismatch");
  }
}

function assertDerivedMoveAncestry(
  prior: WorkspaceLayoutEntry | undefined,
  entry: WorkspaceLayoutEntry,
  priorNavigationEntries: Map<string, WorkspaceLayoutEntry>,
  navigationEntries: Map<string, WorkspaceLayoutEntry>,
): void {
  const parentChanged =
    !prior ||
    workspaceLayoutParentKey(prior) !== workspaceLayoutParentKey(entry) ||
    prior.sectionIntent?.mode !== entry.sectionIntent?.mode;
  if (parentChanged) {
    const oldParent = prior && workspaceLayoutParentKey(prior);
    if (oldParent && !navigationEntries.has(oldParent))
      throw new WorkspaceLayoutRefusal(`required_old_parent_unavailable:${oldParent}`);
    if (prior)
      assertKnownParentChain(
        workspaceLayoutParentKey(prior),
        priorNavigationEntries,
        `${entry.ref.serverId}:${entry.ref.workspaceId}`,
      );
    assertKnownParentChain(
      workspaceLayoutParentKey(entry),
      navigationEntries,
      `${entry.ref.serverId}:${entry.ref.workspaceId}`,
    );
  }
}

function findParent(
  ref: WorkspaceLayoutEntry["ref"],
  entries: Map<string, WorkspaceLayoutEntry>,
  phase: string,
  unknownOwners?: ReadonlySet<string>,
) {
  const parent = entries.get(workspaceReferenceKey(ref)) ?? null;
  if (!parent && phase !== "importing" && !unknownOwners?.has(ref.serverId))
    throw new WorkspaceLayoutRefusal("unresolved_parent");
  return parent;
}

function assertAcyclic(parents: Map<string, string | null>): void {
  const completed = new Set<string>();
  for (const key of parents.keys()) {
    const chain = new Set<string>();
    let current: string | null = key;
    while (current !== null && !completed.has(current)) {
      if (chain.has(current)) throw new WorkspaceLayoutRefusal("workspace_cycle");
      chain.add(current);
      current = parents.get(current) ?? null;
    }
    for (const visited of chain) completed.add(visited);
  }
}

export function hashLayoutValue(value: unknown): string {
  return createHash("sha256").update(canonicalLayoutJson(value)).digest("hex");
}

function receiptKey(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** File + directory sync are required before a canonical revision is acknowledged. */
export async function writeLayoutFileDurably(file: string, value: unknown): Promise<void> {
  await writeFileDurably(file, `${JSON.stringify(value)}\n`);
}
