import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileDurably } from "./atomic-file.js";
import {
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutIdentitySchema,
  WorkspaceLayoutReceiptSchema,
  WorkspaceLayoutSnapshotSchema,
  parseWorkspaceNavigationKey,
  workspaceReferenceKey,
  type WorkspaceLayoutCommit,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutIdentity,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutReceipt,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";

const StoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshot: WorkspaceLayoutSnapshotSchema,
  receipts: z.record(z.string(), WorkspaceLayoutReceiptSchema),
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
        schemaVersion: 1,
        snapshot: {
          stamp: { ...this.identity, revision: 0, phase: "importing" },
          entries: [],
          imports: [],
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
      const prior = Object.hasOwn(current.receipts, input.requestId)
        ? current.receipts[input.requestId]
        : undefined;
      if (prior) {
        if (prior.requestSha256 !== hash) throw new WorkspaceLayoutRefusal("request_id_conflict");
        return structuredClone(prior);
      }
      if (canonicalLayoutJson(input.expected) !== canonicalLayoutJson(current.snapshot.stamp))
        throw new WorkspaceLayoutRefusal("stale_revision");
      if (input.expected.revision === Number.MAX_SAFE_INTEGER)
        throw new WorkspaceLayoutRefusal("revision_exhausted");
      const next = structuredClone(current);
      const revision = current.snapshot.stamp.revision + 1;
      for (const mutation of input.mutations) applyMutation(next.snapshot, mutation, revision);
      validateLayoutGraph(next.snapshot);
      next.snapshot.stamp.revision = revision;
      const receipt: WorkspaceLayoutReceipt = {
        requestId: input.requestId,
        requestSha256: hash,
        stamp: structuredClone(next.snapshot.stamp),
      };
      next.receipts[input.requestId] = receipt;
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
    case "put": {
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
    case "import-host": {
      if (snapshot.stamp.phase !== "importing") throw new WorkspaceLayoutRefusal("import_closed");
      const previous = snapshot.imports.find(
        (source) => source.serverId === mutation.source.serverId,
      );
      if ((previous?.sourceSha256 ?? null) !== mutation.previousSourceSha256)
        throw new WorkspaceLayoutRefusal("stale_import_source");
      if (mutation.entries.some((entry) => entry.ref.serverId !== mutation.source.serverId))
        throw new WorkspaceLayoutRefusal("import_host_mismatch");
      const old = snapshot.entries.filter(
        (entry) => entry.ref.serverId === mutation.source.serverId,
      );
      const keys = new Set(mutation.entries.map((entry) => workspaceReferenceKey(entry.ref)));
      if (old.some((entry) => !keys.has(workspaceReferenceKey(entry.ref))))
        throw new WorkspaceLayoutRefusal("import_drops_existing_workspace");
      snapshot.entries = snapshot.entries.filter(
        (entry) => entry.ref.serverId !== mutation.source.serverId,
      );
      snapshot.entries.push(
        ...mutation.entries.map((entry) => Object.assign({}, entry, { revision })),
      );
      snapshot.imports = snapshot.imports.filter(
        (source) => source.serverId !== mutation.source.serverId,
      );
      snapshot.imports.push(mutation.source);
      return;
    }
    case "activate": {
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
      snapshot.stamp.phase = "active";
    }
  }
}

function layoutSection(entry: WorkspaceLayoutEntry): string {
  if (entry.superpinnedAt) return "superpinned";
  return entry.pinnedAt ? "pinned" : "unpinned";
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
    // The established UI lifts a structurally nested pin into its own section
    // when its parent belongs to another section. Keep that structural link.
    if (!structural || structural.archivedAt || layoutSection(structural) !== layoutSection(entry))
      return null;
    return structural;
  }
  const key = entry.pinPlacement.parentWorkspaceKey;
  if (key === null) return null;
  const parent = findParent(parseWorkspaceNavigationKey(key), entries, phase);
  if (
    parent &&
    !entry.archivedAt &&
    (parent.archivedAt || layoutSection(parent) !== layoutSection(entry))
  )
    throw new WorkspaceLayoutRefusal("parent_section_mismatch");
  return parent;
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

function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function canonicalLayoutJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareKeys(a, b)))
      : item,
  );
}
export function hashLayoutValue(value: unknown): string {
  return createHash("sha256").update(canonicalLayoutJson(value)).digest("hex");
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** File + directory sync are required before a canonical revision is acknowledged. */
export async function writeLayoutFileDurably(file: string, value: unknown): Promise<void> {
  await writeFileDurably(file, `${JSON.stringify(value)}\n`);
}
