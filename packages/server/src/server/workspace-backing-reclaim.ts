import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  stat,
  realpath,
  mkdir,
  opendir,
  lstat,
  rename,
  open,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WorkspaceBackingReclaimInputSchema,
  WorkspaceBackingReclaimBindingSchema,
  type WorkspaceBackingReclaimInput,
  type WorkspaceBackingReclaimOperation,
  type WorkspaceBackingReclaimBinding,
} from "@getpaseo/protocol/workspace-backing-reclaim";
import {
  WorkspaceLayoutIdentitySchema,
  WorkspaceLayoutHomeMarkerSchema,
  workspaceReferenceKey,
  parseWorkspaceNavigationKey,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import { hashLayoutValue, WorkspaceLayoutRefusal } from "./workspace-layout-store.js";
import {
  nativeGeneration,
  readCompletedRetirementForReclaim,
  assertWorkspaceBackingAvailable,
  assertNoRetirementHistoryAtBacking,
  getWorkspaceRetirementStatus,
  type RetirementAuthority,
} from "./workspace-retirement.js";
import {
  serializeWorkspaceBacking,
  nativeTransitionKey,
  canonicalWorkspaceBacking,
} from "./workspace-retirement-context.js";
import {
  readReclaimJournal,
  reclaimFile,
  backingPathsOverlap,
  assertReclaimBackingAvailable,
  type ReclaimJournal,
} from "./workspace-backing-reclaim-journal.js";
import { writeFileDurably } from "./atomic-file.js";
import { promoteWorkspaceLayoutHomeMarker } from "./workspace-layout-home-marker.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { retirementSourceIsCleanAndLanded } from "./workspace-archive-service.js";
import {
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  runWorktreeTeardownCommands,
  getWorktreeTeardownCommands,
} from "../utils/worktree.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { assertWorkspaceAutomationAllowed } from "./workspace-automation-gate.js";
const exec = promisify(execFile);
const running = new Set<string>();
interface LiveHook {
  binding: Omit<WorkspaceBackingReclaimBinding, "ownerReleased" | "externalReferencesClear">;
  verify: () => Promise<void>;
  qualified: boolean;
}
const hooks = new Map<string, LiveHook>();
export interface BackingReclaimDependencies {
  authority: RetirementAuthority;
  inventory: () => Promise<PersistedWorkspaceRecord[]>;
  historyReferences: () => Promise<readonly string[]>;
  liveReferences: () => Promise<readonly string[]>;
  assertHolds: (workspaceId: string) => Promise<void>;
  worktreesRoot?: string;
  teardown?: typeof runWorktreeTeardownCommands;
}
function refuse(code: string): never {
  throw new WorkspaceLayoutRefusal(code);
}
function errorCode(error: unknown): string {
  return error instanceof WorkspaceLayoutRefusal ? error.code : "reclaim_evidence_unverified";
}
const identityStat = async (p: string) => {
  const s = await stat(p);
  return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs };
};
async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec("git", ["-C", cwd, ...args], {
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(cwd, ...args)).trim();
}
function validateIdentity(deps: BackingReclaimDependencies, journal: ReclaimJournal, id: string) {
  if (
    journal.operation.operationId !== id ||
    journal.operation.ownerServerId !== deps.authority.options.serverId ||
    hashLayoutValue(journal.identity) !==
      hashLayoutValue(WorkspaceLayoutIdentitySchema.parse(deps.authority.options.config)) ||
    hashLayoutValue(journal.request) !== journal.requestSha256 ||
    hashLayoutValue(journal.request.target) !== hashLayoutValue(journal.operation.target)
  )
    refuse("reclaim_journal_unverified");
  if (journal.operation.receipt) {
    const { receipt, ...outcome } = journal.operation;
    if (
      receipt.requestSha256 !== journal.requestSha256 ||
      receipt.id !== `reclaim:${id}:${receipt.resultSha256}` ||
      receipt.resultSha256 !== hashLayoutValue({ ...outcome, receipt: null })
    )
      refuse("reclaim_receipt_unverified");
  }
}
export async function getBackingReclaimStatus(
  deps: BackingReclaimDependencies,
  id: string,
): Promise<WorkspaceBackingReclaimOperation | null> {
  id = z.string().uuid().parse(id).toLowerCase();
  const journal = await readReclaimJournal(deps.authority.options.home, id);
  if (!journal) return null;
  validateIdentity(deps, journal, id);
  if (
    journal.operation.state === "pending" &&
    !running.has(reclaimFile(deps.authority.options.home, id))
  )
    return {
      ...journal.operation,
      ...(journal.quarantinePath ? { quarantinePath: journal.quarantinePath } : {}),
      state: "partial",
      terminal: false,
      code: "reclaim_reconciliation_required",
    };
  return journal.operation;
}
type LayoutEntry = WorkspaceLayoutSnapshot["entries"][number];
function parentKeys(entry: LayoutEntry): string[] {
  return [
    ...(entry.parent ? [workspaceReferenceKey(entry.parent)] : []),
    ...(entry.pinPlacement?.parentWorkspaceKey
      ? [workspaceReferenceKey(parseWorkspaceNavigationKey(entry.pinPlacement.parentWorkspaceKey))]
      : []),
  ];
}
function checkReclaimAncestors(
  snapshot: WorkspaceLayoutSnapshot,
  entries: Map<string, LayoutEntry>,
  targets: Set<string>,
  owner: string,
) {
  for (const key of targets) {
    const target = entries.get(key);
    if (!target) refuse("reclaim_ancestry_unknown");
    const seen = new Set<string>(),
      active = new Set([key]),
      pending = parentKeys(target).map((parentKey) => ({ key: parentKey, exit: false }));
    while (pending.length) {
      const { key: next, exit } = pending.pop()!;
      if (exit) {
        active.delete(next);
        seen.add(next);
        continue;
      }
      if (active.has(next)) refuse("reclaim_ancestry_unknown");
      if (seen.has(next)) continue;
      active.add(next);
      const entry = entries.get(next);
      if (
        !entry ||
        entry.ref.serverId !== owner ||
        snapshot.ownerDomains?.find((d) => d.serverId === entry.ref.serverId)?.state !== "adopted"
      )
        refuse("reclaim_ancestry_unknown");
      if (entry.pinnedAt || entry.superpinnedAt) refuse("reclaim_layout_hold");
      pending.push(
        { key: next, exit: true },
        ...parentKeys(entry).map((parentKey) => ({ key: parentKey, exit: false })),
      );
    }
  }
}
function checkReclaimDescendants(
  snapshot: WorkspaceLayoutSnapshot,
  entries: Map<string, LayoutEntry>,
  targets: Set<string>,
) {
  for (const entry of snapshot.entries) {
    if (entry.archivedAt && !entry.pinnedAt && !entry.superpinnedAt) continue;
    const seen = new Set<string>(),
      pending = parentKeys(entry);
    while (pending.length) {
      const key = pending.pop()!;
      if (targets.has(key)) refuse("reclaim_live_descendant");
      if (seen.has(key)) continue;
      seen.add(key);
      const parent = entries.get(key);
      if (parent) pending.push(...parentKeys(parent));
    }
  }
}
function checkLayout(
  snapshot: WorkspaceLayoutSnapshot,
  rows: PersistedWorkspaceRecord[],
  ids: Set<string>,
  owner: string,
) {
  if (snapshot.semanticsVersion !== 2 || snapshot.stamp.phase !== "active")
    refuse("reclaim_active_layout_required");
  if (snapshot.ownerDomains?.find((d) => d.serverId === owner)?.state !== "adopted")
    refuse("reclaim_owner_unverified");
  for (const entry of snapshot.entries)
    if (
      entry.ref.serverId === owner &&
      !rows.some((r) => r.workspaceId === entry.ref.workspaceId) &&
      (!entry.archivedAt || entry.pinnedAt || entry.superpinnedAt)
    )
      refuse("reclaim_native_inventory_incomplete");
  const entries = new Map(snapshot.entries.map((e) => [workspaceReferenceKey(e.ref), e])),
    targets = new Set(
      [...ids].map((workspaceId) => workspaceReferenceKey({ serverId: owner, workspaceId })),
    );
  checkReclaimAncestors(snapshot, entries, targets, owner);
  checkReclaimDescendants(snapshot, entries, targets);
}
async function observeManagedGit(deps: BackingReclaimDependencies, targetPath: string) {
  const home = deps.authority.options.home,
    canonical = await realpath(targetPath);
  if (canonical !== targetPath) refuse("reclaim_exact_canonical_path_required");
  await assertNoEnclosingGit(targetPath);
  const ownership = await isPaseoOwnedWorktreeCwd(targetPath, {
    paseoHome: home,
    worktreesRoot: deps.worktreesRoot,
  });
  if (
    !ownership.allowed ||
    !ownership.repoRoot ||
    path.resolve(ownership.worktreePath ?? "") !== targetPath
  )
    refuse("reclaim_managed_worktree_required");
  const repo = await realpath(ownership.repoRoot);
  if (repo === canonical) refuse("reclaim_main_checkout_forbidden");
  const metadata = await readPaseoWorktreeMetadata(targetPath);
  if (!metadata) refuse("reclaim_managed_marker_required");
  // NUL framing preserves spaces, newlines and Git's unquoted path bytes.
  const registrations = (await gitOutput(repo, "worktree", "list", "--porcelain", "-z"))
    .split("\0\0")
    .filter(Boolean);
  let registration: string | undefined;
  for (const entry of registrations) {
    const first = entry.split("\0", 1)[0];
    if (!first.startsWith("worktree ")) refuse("reclaim_git_inventory_unknown");
    const registeredPath = first.slice("worktree ".length);
    if (registeredPath === targetPath) registration = entry;
    else {
      if (!path.isAbsolute(registeredPath)) refuse("reclaim_git_inventory_unknown");
      const normalize = (value: string) =>
        process.platform === "darwin" || process.platform === "win32"
          ? value.normalize("NFC").toLowerCase()
          : value;
      const relative = path.relative(
        normalize(targetPath),
        normalize(await canonicalWorkspaceBacking(registeredPath)),
      );
      if (await backingPathsOverlap(targetPath, registeredPath))
        refuse(
          relative.startsWith(`..${path.sep}`) || relative === ".."
            ? "reclaim_enclosing_worktree"
            : "reclaim_nested_worktree",
        );
    }
  }
  if (!registration) refuse("reclaim_git_registration_required");
  if (registration.split("\0").some((field) => field === "locked" || field.startsWith("locked ")))
    refuse("reclaim_git_worktree_locked");
  await assertNoNestedGitBoundary(targetPath);
  const top = await realpath(await git(targetPath, "rev-parse", "--show-toplevel"));
  if (top !== targetPath) refuse("reclaim_exact_root_required");
  const gitDir = await realpath(await git(targetPath, "rev-parse", "--absolute-git-dir"));
  const gitfile = await readFile(path.join(targetPath, ".git"), "utf8");
  if (!gitfile.startsWith("gitdir: ") || !path.isAbsolute(gitfile.slice(8).trim()))
    refuse("reclaim_git_relocation_unverified");
  return { repo, metadata, registration, gitDir };
}

async function assertNoEnclosingGit(root: string): Promise<void> {
  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    const exists = async (name: string) => {
      try {
        await lstat(path.join(parent, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    if (
      (await exists(".git")) ||
      ((await exists("HEAD")) && (await exists("objects")) && (await exists("refs")))
    )
      refuse("reclaim_enclosing_worktree");
    if (path.dirname(parent) === parent) return;
  }
}

async function assertHistoryOutside(deps: BackingReclaimDependencies, roots: string[]) {
  const references = [...new Set(await deps.historyReferences())].sort();
  for (const reference of references) {
    if (!path.isAbsolute(reference)) refuse("reclaim_history_inventory_unverified");
    const resolveHistory = async (value: string): Promise<string> => {
      try {
        return await realpath(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const entry = await lstat(value).catch((missing: NodeJS.ErrnoException) => {
          if (missing.code === "ENOENT") return null;
          throw missing;
        });
        if (entry?.isSymbolicLink()) refuse("reclaim_history_inventory_unverified");
        const parent = path.dirname(value);
        if (parent === value) throw error;
        return path.join(await resolveHistory(parent), path.basename(value));
      }
    };
    const physical = await resolveHistory(reference);
    for (const root of roots) {
      // Preserve lexical links inside the backing as well as outside links into it.
      const inside = (value: string) => {
        const key = (s: string) =>
          process.platform === "darwin" || process.platform === "win32"
            ? s.normalize("NFC").toLowerCase()
            : s;
        const relative = path.relative(key(root), key(value));
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      };
      if (inside(path.resolve(reference)) || inside(physical)) refuse("reclaim_history_reference");
    }
  }
  return references;
}

/** Ignored and other-repository worktrees are absent from the owner's Git registry. */
async function assertNoNestedGitBoundary(root: string): Promise<void> {
  const pending = [root];
  let remaining = 100000;
  while (pending.length) {
    const directory = pending.pop()!;
    // Streaming keeps traversal memory bounded even for a large ignored directory.
    const entries = await opendir(directory);
    const bareMarkers = new Set<string>();
    for await (const entry of entries) {
      if (--remaining < 0) refuse("reclaim_git_inventory_unknown");
      const name =
        process.platform === "darwin" || process.platform === "win32"
          ? entry.name.toLowerCase()
          : entry.name;
      if (directory !== root && ["head", "HEAD", "objects", "refs"].includes(name)) {
        bareMarkers.add(name.toLowerCase());
        if (bareMarkers.size === 3) refuse("reclaim_nested_worktree");
      }
      if (name === ".git") {
        if (directory !== root) refuse("reclaim_nested_worktree");
        continue;
      }
      // Git removal unlinks symlinks; it does not traverse their targets.
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      else if (!entry.isFile() && !entry.isSymbolicLink()) refuse("reclaim_git_inventory_unknown");
    }
  }
}
async function observeOriginal(
  deps: BackingReclaimDependencies,
  target: Extract<WorkspaceBackingReclaimInput["target"], { kind: "retired" }>,
  rows: PersistedWorkspaceRecord[],
  snapshot: WorkspaceLayoutSnapshot,
  targetPath: string,
) {
  const { authority } = deps,
    op = snapshot.retirements?.find((o) => o.operationId === target.retirementOperationId);
  if (
    !op ||
    !op.targets.some(
      (t) =>
        t.ref.serverId === authority.options.serverId && t.ref.workspaceId === target.workspaceId,
    )
  )
    refuse("reclaim_original_operation_unverified");
  const originals: PersistedWorkspaceRecord[] = [];
  for (const t of op.targets) {
    const row = rows.find((r) => r.workspaceId === t.ref.workspaceId);
    if (t.ref.serverId !== authority.options.serverId || !row || !row.archivedAt)
      refuse("reclaim_original_identity_unverified");
    originals.push(row);
  }
  const { journal } = await readCompletedRetirementForReclaim(
    authority,
    target.retirementOperationId,
    target.backingGeneration,
    originals,
  );
  if (
    journal.backingPath !== targetPath ||
    journal.result?.directoryLeftBehind?.path !== targetPath
  )
    refuse("reclaim_original_path_changed");
  const observed = await Promise.all(
    journal.backingPaths.map(async (p) => {
      const shared: PersistedWorkspaceRecord[] = [];
      for (const row of rows.filter(
        (r) => !r.archivedAt && !originals.some((o) => o.workspaceId === r.workspaceId),
      ))
        if (await backingPathsOverlap(p, row.worktreeRoot ?? row.cwd)) shared.push(row);
      return { path: p, refs: nativeGeneration(shared), stat: await identityStat(p) };
    }),
  );
  if (
    hashLayoutValue({ observed, generation: nativeGeneration(originals) }) !==
    target.backingGeneration
  )
    refuse("reclaim_original_backing_changed");
  return originals;
}
async function checkNativeReferences(
  deps: BackingReclaimDependencies,
  rows: PersistedWorkspaceRecord[],
  snapshot: WorkspaceLayoutSnapshot,
  ids: Set<string>,
  targetPath: string,
) {
  for (const row of rows) {
    if (!(await backingPathsOverlap(targetPath, row.worktreeRoot ?? row.cwd))) continue;
    if (!ids.has(row.workspaceId)) refuse("reclaim_native_reference");
    if (
      !row.archivedAt ||
      row.pinnedAt ||
      row.superpinnedAt ||
      /do not archive/i.test(`${row.title ?? ""} ${row.displayName}`)
    )
      refuse("reclaim_native_hold");
    const entry = snapshot.entries.find(
      (e) =>
        e.ref.serverId === deps.authority.options.serverId && e.ref.workspaceId === row.workspaceId,
    );
    if (!entry?.archivedAt || entry.pinnedAt || entry.superpinnedAt) refuse("reclaim_layout_hold");
    assertWorkspaceAutomationAllowed(row.untrustedSource);
    await deps.assertHolds(row.workspaceId);
  }
  for (const live of await deps.liveReferences())
    if (await backingPathsOverlap(targetPath, live)) refuse("reclaim_live_reference");
}
async function observe(
  deps: BackingReclaimDependencies,
  input: WorkspaceBackingReclaimInput,
  ownId?: string,
) {
  const { authority } = deps,
    home = authority.options.home;
  const marker = WorkspaceLayoutHomeMarkerSchema.parse(
    JSON.parse(await readFile(path.join(home, "workspace-layout-mode.json"), "utf8")),
  );
  const { schemaVersion: _v, destructiveRetirement: _r, ...bound } = marker;
  if (hashLayoutValue(bound) !== hashLayoutValue(authority.options.config))
    refuse("home_authority_binding_changed");
  const targetPath = path.resolve(input.target.path);
  if (!path.isAbsolute(input.target.path)) refuse("reclaim_exact_canonical_path_required");
  const { repo, metadata, registration, gitDir } = await observeManagedGit(deps, targetPath);
  const histories = await assertHistoryOutside(deps, [targetPath]);
  const rows = await deps.inventory(),
    snapshot = await authority.inspect();
  const originals =
    input.target.kind === "retired"
      ? await observeOriginal(deps, input.target, rows, snapshot, targetPath)
      : [];
  const teardownCwd = originals[0]?.cwd ?? targetPath;
  if (!deps.teardown && !(await getWorktreeTeardownCommands(teardownCwd)).length)
    refuse("reclaim_release_guard_required");
  if (input.target.kind === "orphan") await assertNoRetirementHistoryAtBacking(home, targetPath);
  const ids = new Set(originals.map((r) => r.workspaceId));
  checkLayout(snapshot, rows, ids, authority.options.serverId);
  await checkNativeReferences(deps, rows, snapshot, ids, targetPath);
  // This bypasses only this invocation's own durable reclaim fence, never an archive reservation.
  await assertReclaimBackingAvailable(home, targetPath, ownId);
  await assertWorkspaceBackingAvailable(
    home,
    targetPath,
    snapshot,
    authority.options.serverId,
    ownId,
  );
  if (!(await retirementSourceIsCleanAndLanded(targetPath, repo)))
    refuse("reclaim_source_preserved");
  const operands = {
    identity: bound,
    target: input.target,
    releaseEvidence: input.releaseEvidence,
    histories,
    native: rows.filter((r) => ids.has(r.workspaceId)),
    layout: snapshot.entries.filter(
      (e) => e.ref.serverId === authority.options.serverId && ids.has(e.ref.workspaceId),
    ),
    root: await identityStat(targetPath),
    gitDir,
    gitIdentity: await identityStat(gitDir),
    metadata,
    head: await git(targetPath, "rev-parse", "HEAD"),
    registration,
  };
  return {
    generation: hashLayoutValue(operands),
    repo,
    targetPath,
    gitDir,
    observed: operands,
    ids,
    teardownCwd,
  };
}
export async function previewBackingReclaim(
  deps: BackingReclaimDependencies,
  raw: WorkspaceBackingReclaimInput,
) {
  const input = WorkspaceBackingReclaimInputSchema.parse(raw);
  try {
    const result = await serializeWorkspaceBacking(input.target.path, () => observe(deps, input));
    return { target: input.target, eligible: true, code: null, generation: result.generation };
  } catch (error) {
    return { target: input.target, eligible: false, code: errorCode(error), generation: null };
  }
}
function hookKey(home: string, id: string) {
  return `${path.resolve(home)}:${id}`;
}
export async function verifyBackingReclaimHook(home: string, raw: WorkspaceBackingReclaimBinding) {
  const input = WorkspaceBackingReclaimBindingSchema.parse(raw),
    key = hookKey(home, input.operationId),
    hook = hooks.get(key);
  if (!hook) return { valid: false, code: "reclaim_hook_not_active" };
  if (
    hashLayoutValue(hook.binding) !==
    hashLayoutValue({
      operationId: input.operationId,
      generation: input.generation,
      path: input.path,
      releaseEvidence: input.releaseEvidence,
    })
  )
    return { valid: false, code: "reclaim_hook_binding_changed" };
  try {
    await hook.verify();
    if (hooks.get(key) !== hook) refuse("reclaim_hook_not_active");
    hook.qualified = true;
    return { valid: true, code: null };
  } catch (error) {
    return { valid: false, code: errorCode(error) };
  }
}
export async function applyBackingReclaim(
  deps: BackingReclaimDependencies,
  raw: WorkspaceBackingReclaimInput & { operationId: string; expectedGeneration: string },
): Promise<WorkspaceBackingReclaimOperation> {
  const input = WorkspaceBackingReclaimInputSchema.parse(raw),
    id = z.string().uuid().parse(raw.operationId).toLowerCase(),
    generation = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(raw.expectedGeneration),
    home = deps.authority.options.home;
  const requestSha = hashLayoutValue(input),
    file = reclaimFile(home, id);
  if (!path.isAbsolute(input.target.path)) refuse("reclaim_exact_canonical_path_required");
  const replay = async () => {
    const journal = await readReclaimJournal(home, id);
    if (!journal) return null;
    validateIdentity(deps, journal, id);
    if (journal.requestSha256 !== requestSha || journal.operation.generation !== generation)
      refuse("reclaim_operation_id_conflict");
    return getBackingReclaimStatus(deps, id);
  };
  const existing = await replay();
  if (existing) return existing;
  if (await getWorkspaceRetirementStatus(deps.authority, id))
    refuse("reclaim_operation_id_conflict");
  const keys = [nativeTransitionKey(home, "workspace", `retirement-operation:${id}`)];
  if (input.target.kind === "retired")
    keys.push(nativeTransitionKey(home, "workspace", input.target.workspaceId));
  return serializeWorkspaceBacking({ paths: [input.target.path], keys }, async () => {
    const replayed = await replay();
    if (replayed) return replayed;
    if (await getWorkspaceRetirementStatus(deps.authority, id))
      refuse("reclaim_operation_id_conflict");
    if (await readReclaimJournal(home, id)) refuse("reclaim_operation_id_conflict");
    const journal: ReclaimJournal = {
      schemaVersion: 1,
      identity: WorkspaceLayoutIdentitySchema.parse(deps.authority.options.config),
      request: input,
      requestSha256: requestSha,
      operation: {
        operationId: id,
        ownerServerId: deps.authority.options.serverId,
        target: input.target,
        generation,
        state: "pending",
        terminal: false,
        code: null,
        removedDirectory: false,
        receipt: null,
      },
      step: "intent",
    };
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const persist = () => writeFileDurably(file, JSON.stringify(journal));
    await persist();
    running.add(file);
    const verify = async () => {
      const current = await observe(deps, input, id);
      if (current.generation !== generation) refuse("reclaim_generation_changed");
      return current;
    };
    try {
      const current = await verify();
      // Older owner binaries do not understand the new durable reclaim fence.
      // Their marker parser must refuse this home before observing or registering paths.
      await promoteWorkspaceLayoutHomeMarker(home, deps.authority.options.config, 4);
      const binding = {
        operationId: id,
        generation,
        path: current.targetPath,
        releaseEvidence: input.releaseEvidence,
      };
      const hook: LiveHook = {
        binding,
        verify: async () => {
          await verify();
        },
        qualified: false,
      };
      journal.step = "teardown-started";
      await persist();
      const key = hookKey(home, id);
      hooks.set(key, hook);
      try {
        await (deps.teardown ?? runWorktreeTeardownCommands)({
          worktreePath: current.targetPath,
          teardownCwd: current.teardownCwd,
          repoRootPath: current.repo,
          paseoReclaimBinding: binding,
          retirementHome: home,
        });
        if (!hook.qualified) refuse("reclaim_release_guard_required");
      } finally {
        hooks.delete(key);
      }
      journal.step = "teardown-done";
      await persist();
      await verify();
      const container = path.join(path.dirname(current.targetPath), `.paseo-reclaim-${id}`);
      const quarantined = path.join(container, "backing");
      journal.quarantinePath = quarantined;
      journal.quarantineIdentity = { root: current.observed.root, gitDir: current.gitDir };
      journal.operation.quarantinePath = quarantined;
      // Git's own lock prevents an external prune from discarding/reusing the
      // captured administration while the original backing pathname is absent.
      journal.gitLock = { reason: `paseo-reclaim:${id}:${generation}`, released: false };
      journal.step = "git-lock-started";
      await persist();
      await git(
        current.repo,
        "worktree",
        "lock",
        "--reason",
        journal.gitLock.reason,
        current.targetPath,
      );
      const readOwnedGitLock = async () => {
        if (
          hashLayoutValue(await identityStat(current.gitDir)) !==
          hashLayoutValue(current.observed.gitIdentity)
        )
          refuse("reclaim_generation_changed");
        const lockPath = path.join(current.gitDir, "locked");
        const lockStat = await lstat(lockPath);
        if (
          !lockStat.isFile() ||
          (await readFile(lockPath, "utf8")) !== `${journal.gitLock!.reason}\n`
        )
          refuse("reclaim_git_lock_unverified");
        return { dev: lockStat.dev, ino: lockStat.ino, birthtimeMs: lockStat.birthtimeMs };
      };
      journal.gitLock.identity = await readOwnedGitLock();
      const assertOwnedGitLock = async () => {
        if (
          hashLayoutValue(await readOwnedGitLock()) !== hashLayoutValue(journal.gitLock!.identity)
        )
          refuse("reclaim_git_lock_unverified");
      };
      journal.step = "git-lock-held";
      await persist();
      journal.step = "quarantine-started";
      await persist();
      await serializeWorkspaceBacking({ paths: [container] }, async () => {
        await mkdir(container, { mode: 0o700 });
        // Same-parent, same-volume rename; never copy or remove using the old pathname.
        await rename(current.targetPath, quarantined);
        if (
          hashLayoutValue(await identityStat(quarantined)) !==
          hashLayoutValue(current.observed.root)
        )
          refuse("reclaim_generation_changed");
        journal.operation.quarantinePath = quarantined;
        if (process.platform !== "win32") {
          for (const directory of [container, path.dirname(container)]) {
            const fd = await open(directory, "r");
            try {
              await fd.sync();
            } finally {
              await fd.close();
            }
          }
        }
        journal.step = "quarantine-done";
        await persist();
        await assertNoNestedGitBoundary(quarantined);
        await assertNoEnclosingGit(quarantined);
        await assertHistoryOutside(deps, [current.targetPath, quarantined]);
        journal.step = "repair-started";
        await persist();
        await assertOwnedGitLock();
        // Repair only this exact captured admin directory, after the private tree qualifies.
        const gitfile = await readFile(path.join(quarantined, ".git"), "utf8");
        if ((await realpath(gitfile.slice(8).trim())) !== current.gitDir)
          refuse("reclaim_git_relocation_unverified");
        await git(current.repo, "worktree", "repair", quarantined);
        journal.step = "repair-done";
        await persist();
        journal.step = "remove-started";
        await persist();
        // All journal waits precede the final scan. Late writers at the OLD path
        // can create another generation, but can never make us delete that path.
        const reused = await lstat(current.targetPath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (reused) refuse("reclaim_original_path_reused");
        const rows = await deps.inventory(),
          snapshot = await deps.authority.inspect();
        checkLayout(snapshot, rows, current.ids, deps.authority.options.serverId);
        await checkNativeReferences(deps, rows, snapshot, current.ids, current.targetPath);
        await checkNativeReferences(deps, rows, snapshot, current.ids, quarantined);
        const histories = await assertHistoryOutside(deps, [current.targetPath, quarantined]);
        const detached = {
          ...current.observed,
          histories,
          native: rows.filter((row) => current.ids.has(row.workspaceId)),
          layout: snapshot.entries.filter(
            (entry) =>
              entry.ref.serverId === deps.authority.options.serverId &&
              current.ids.has(entry.ref.workspaceId),
          ),
          root: await identityStat(quarantined),
          gitIdentity: await identityStat(current.gitDir),
          head: await git(quarantined, "rev-parse", "HEAD"),
        };
        if (hashLayoutValue(detached) !== hashLayoutValue(current.observed))
          refuse("reclaim_generation_changed");
        await assertOwnedGitLock();
        await git(current.repo, "worktree", "unlock", quarantined);
        journal.gitLock!.released = true;
        // No journal wait after unlocking: final evidence and non-forcing
        // removal now address the registered, relocated tree only.
        const moved = await observeManagedGit(deps, quarantined);
        if (
          hashLayoutValue(moved.registration.split("\0").slice(1)) !==
          hashLayoutValue(current.observed.registration.split("\0").slice(1))
        )
          refuse("reclaim_generation_changed");
        if (
          moved.gitDir !== current.gitDir ||
          hashLayoutValue(moved.metadata) !== hashLayoutValue(current.observed.metadata)
        )
          refuse("reclaim_git_relocation_unverified");
        if (!(await retirementSourceIsCleanAndLanded(quarantined, current.repo)))
          refuse("reclaim_source_preserved");
        await deletePaseoWorktree({
          cwd: current.repo,
          worktreePath: quarantined,
          paseoHome: home,
          worktreesBaseRoot: deps.worktreesRoot,
          teardownCwds: [],
          requireCleanRemoval: true,
        });
        journal.operation.removedDirectory = true;
        delete journal.operation.quarantinePath;
        await rmdir(container);
      });
      journal.step = "remove-done";
      journal.operation = {
        ...journal.operation,
        state: "complete",
        terminal: true,
        removedDirectory: true,
      };
      const resultSha256 = hashLayoutValue(journal.operation);
      journal.operation.receipt = {
        id: `reclaim:${id}:${resultSha256}`,
        requestSha256: requestSha,
        resultSha256,
      };
      await persist();
      return journal.operation;
    } catch (error) {
      journal.operation = {
        ...journal.operation,
        state: journal.step === "intent" ? "refused" : "partial",
        terminal: journal.step === "intent",
        code: errorCode(error),
        receipt: null,
      };
      await persist();
      return journal.operation;
    } finally {
      running.delete(file);
    }
  });
}
