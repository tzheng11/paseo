import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileDurably } from "./atomic-file.js";
import {
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutIdentitySchema,
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
} from "@getpaseo/protocol/workspace-layout";
export { canonicalLayoutJson } from "@getpaseo/protocol/workspace-layout";

const StoreSchema = z.strictObject({
  schemaVersion: z.literal(3),
  snapshot: WorkspaceLayoutSnapshotSchema,
  receipts: z.record(z.string().regex(/^[a-f0-9]{64}$/), WorkspaceLayoutReceiptSchema),
});
type StoreFile = z.infer<typeof StoreSchema>;
const GuardSchema = WorkspaceLayoutIdentitySchema.extend({
  schemaVersion: z.literal(1),
  initialized: z.boolean(),
});

export class WorkspaceLayoutRefusal extends Error {
  constructor(readonly code: string) {
    super(`Workspace layout refused: ${code}`);
    this.name = "WorkspaceLayoutRefusal";
  }
}

export interface WorkspaceLayoutStoreOptions {
  paseoHome: string;
  identity: WorkspaceLayoutIdentity;
  serverId: string;
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
        schemaVersion: 3,
        snapshot: {
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
      if (canonicalLayoutJson(input.expected) !== canonicalLayoutJson(current.snapshot.stamp))
        throw new WorkspaceLayoutRefusal("stale_revision");
      if (input.expected.revision === Number.MAX_SAFE_INTEGER)
        throw new WorkspaceLayoutRefusal("revision_exhausted");
      const next = structuredClone(current);
      const revision = current.snapshot.stamp.revision + 1;
      for (const mutation of input.mutations) applyMutation(next.snapshot, mutation, revision);
      validateNewNavigationParents(current.snapshot, next.snapshot, input.mutations);
      validateLayoutGraph(next.snapshot);
      next.snapshot.stamp.revision = revision;
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
  switch (mutation.kind) {
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
  if ((prior?.revision ?? 0) !== mutation.entry.revision)
    throw new WorkspaceLayoutRefusal("stale_entry_revision");
  const next = { ...mutation.entry, revision };
  if (index < 0) snapshot.entries.push(next);
  else snapshot.entries[index] = next;
  return;
}

function importLayoutHost(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "import-host" }>,
  revision: number,
) {
  if (snapshot.stamp.phase !== "importing") throw new WorkspaceLayoutRefusal("import_closed");
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
  return;
}

function activateLayout(
  snapshot: WorkspaceLayoutSnapshot,
  mutation: Extract<WorkspaceLayoutMutation, { kind: "activate" }>,
) {
  if (snapshot.stamp.phase !== "importing") throw new WorkspaceLayoutRefusal("already_active");
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

/** A durable receipt plus its exact CAS input can advance a known full snapshot without another read. */
export function projectConfirmedLayout(
  snapshot: WorkspaceLayoutSnapshot,
  input: WorkspaceLayoutCommit,
  receipt: WorkspaceLayoutReceipt,
): WorkspaceLayoutSnapshot | null {
  if (canonicalLayoutJson(snapshot.stamp) !== canonicalLayoutJson(input.expected)) return null;
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

export function validateLayoutGraph(snapshot: WorkspaceLayoutSnapshot): void {
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
  for (const [key, entry] of entries) {
    const parent = structuralParent(entry, entries, snapshot.stamp.phase);
    structural.set(key, parent ? workspaceReferenceKey(parent.ref) : null);
    const placement = navigationParent(entry, parent, entries, snapshot.stamp.phase);
    navigation.set(key, placement ? workspaceReferenceKey(placement.ref) : null);
  }
  assertAcyclic(structural);
  assertAcyclic(navigation);
  validateNavigation(snapshot, entries);
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
        findParent(parseWorkspaceNavigationKey(key), entries, snapshot.stamp.phase);
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
) {
  if (!entry.parent) return null;
  if (entry.parent.serverId !== entry.ref.serverId)
    throw new WorkspaceLayoutRefusal("structural_parent_host_mismatch");
  const parent = findParent(entry.parent, entries, phase);
  if (parent && parent.projectId !== entry.projectId)
    throw new WorkspaceLayoutRefusal("structural_parent_project_mismatch");
  return parent;
}

function navigationParent(
  entry: WorkspaceLayoutEntry,
  structural: WorkspaceLayoutEntry | null,
  entries: Map<string, WorkspaceLayoutEntry>,
  phase: string,
) {
  if (!entry.pinPlacement) {
    // Validate stored edges, including dormant ones, so later reactivation
    // cannot reveal a cycle. Visible eligibility belongs to the UI projection.
    return structural;
  }
  const key = entry.pinPlacement.parentWorkspaceKey;
  if (key === null) return null;
  const parent = findParent(parseWorkspaceNavigationKey(key), entries, phase);
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
  for (const mutation of mutations) {
    if (mutation.kind !== "put") continue;
    const entry = mutation.entry;
    const parentKey = entry.pinPlacement?.parentWorkspaceKey;
    if (
      parentKey == null ||
      before.get(workspaceReferenceKey(entry.ref))?.pinPlacement?.parentWorkspaceKey === parentKey
    )
      continue;
    const parent = findParent(parseWorkspaceNavigationKey(parentKey), after, next.stamp.phase);
    if (
      parent &&
      (parent.archivedAt || entry.archivedAt || layoutSection(parent) !== layoutSection(entry))
    )
      throw new WorkspaceLayoutRefusal("parent_section_mismatch");
  }
}

function findParent(
  ref: WorkspaceLayoutEntry["ref"],
  entries: Map<string, WorkspaceLayoutEntry>,
  phase: string,
) {
  const parent = entries.get(workspaceReferenceKey(ref)) ?? null;
  if (!parent && phase !== "importing") throw new WorkspaceLayoutRefusal("unresolved_parent");
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
