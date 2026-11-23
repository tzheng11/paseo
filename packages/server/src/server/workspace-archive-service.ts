import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  retireCanonicalWorkspace,
  recoverCanonicalWorkspaceRetirement,
  type RetirementAuthority,
  nativeGeneration,
  commitWorkspaceRetirementArchive,
  hasWorkspaceRetirement,
  workspaceRetirementStep,
  withCallerRetirementOperation,
  withWorkspaceRetirementHook,
} from "./workspace-retirement.js";
import { serializeWorkspaceBacking, nativeTransitionKey } from "./workspace-retirement-context.js";
import { resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  runWorktreeTeardownCommands,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceArchiveContext,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { runWithGitCommandPriority, GitCommandTimeoutError } from "../utils/run-git-command.js";
import { WorkspaceLayoutRefusal } from "./workspace-layout-store.js";
import { WorkspaceAutomationBlockedError } from "./workspace-automation-gate.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { assertWorkspaceRetirementAllowed } from "./workspace-layout-mode.js";

const POST_ARCHIVE_SNAPSHOT_TIMEOUT_MS = 5_000;

export type ActiveWorkspaceRef = Pick<
  PersistedWorkspaceRecord,
  "workspaceId" | "cwd" | "kind" | "worktreeRoot" | "isPaseoOwnedWorktree" | "mainRepoRoot"
>;

export interface ArchiveDependencies {
  retirementAuthority?: RetirementAuthority;
  listRetirementRecords?: () => Promise<PersistedWorkspaceRecord[]>;
  paseoHome?: string;
  // Base directory that may hold worktrees across repositories.
  paseoWorktreesBaseRoot?: string;
  github: ForgeService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "invalidateWorktrees">;
  agentManager: Pick<AgentManager, "listAgents" | "getAgent" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "listByWorkspace">;
  // Resolves the worktree at a path to its workspaceId for archive-by-path. The
  // path uniquely identifies a worktree workspace; this is a directory lookup for
  // the archive target, not status/ownership.
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  getWorkspace?: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  // Active (non-archived) workspaces, used to decide whether the workspace being
  // archived is the last reference to its backing worktree directory, and to
  // break a same-cwd tie in favor of the worktree-kind record when archiving by
  // path (no explicit workspaceId).
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  stopWorkspaceSetup?: (workspaceId: string) => Promise<void>;
  assertWorkspaceAutomationAllowed?: (workspaceId: string) => Promise<void>;
  sessionLogger?: Logger;
}

export interface KillTerminalsForWorkspaceDependencies {
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
}

export type ArchiveScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "worktree"; targetPath: string; expectedBackingGeneration?: string }
  | {
      kind: "project";
      projectId: string;
      workspaceIds?: string[];
      expectedBackingGeneration?: string;
    };

export interface ArchiveResult {
  slotKept?: boolean;
  retirement?: import("./workspace-retirement.js").RetirementResult["retirement"];
  archivedAgentIds: string[];
  archivedWorkspaceIds: string[];
  removedDirectory: boolean;
  // Set when the record archived but its worktree directory was left on
  // disk because no ownership proof held for it. The directory is never
  // deleted in that case; the path and reason surface here and in the log.
  directoryLeftBehind?: { path: string; reason: string };
}

export interface ArchiveByScopeRequest {
  recoverRetirement?: boolean;
  operationId?: string;
  scope: ArchiveScope;
  requestId: string;
}

export async function requireActiveWorkspaceForArchive(
  dependencies: Pick<ArchiveDependencies, "listActiveWorkspaces">,
  workspaceId: string,
): Promise<ActiveWorkspaceRef> {
  const workspace = (await dependencies.listActiveWorkspaces()).find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

interface BackingDirectory {
  path: string;
  isPaseoOwnedWorktree: boolean;
  // True when the directory backs a worktree workspace (or a worktree-scope
  // archive), so a failed ownership proof means a Paseo worktree directory
  // is being left behind rather than a user's local checkout being ignored.
  expectsPaseoOwnership: boolean;
  // True only when this backing came from a workspace registry record
  // matched to this path (the record is itself an ownership proof, passed
  // through to deletePaseoWorktree). Disk-derived backings stay false:
  // they must prove ownership on disk.
  registryProven: boolean;
  mainRepoRoot: string | null;
  paseoWorktreesRoot: string | null;
}

interface ArchiveTarget {
  backing: BackingDirectory | null;
  teardownTargets: Array<{ workspaceId: string | null; cwd: string }>;
  setupWorkspaceIds: string[];
  workspaceIds: string[];
}

export async function resolveWorkspaceIdAtPath(
  dependencies: Pick<ArchiveDependencies, "findWorkspaceIdForCwd" | "listActiveWorkspaces">,
  targetPath: string,
): Promise<string | null> {
  const matchesTarget = createRealpathAwarePathMatcher(targetPath);
  const activeWorkspaces = await dependencies.listActiveWorkspaces();
  const exactMatches = activeWorkspaces.filter((workspace) => matchesTarget(workspace.cwd));
  const worktreeMatch = exactMatches.find((workspace) => workspace.kind === "worktree");
  if (worktreeMatch) {
    return worktreeMatch.workspaceId;
  }
  return dependencies.findWorkspaceIdForCwd(targetPath);
}

// Resolves the in-scope record set, tears each down
// (agents + terminals + record), then removes the backing directory iff it is
// Paseo-owned AND no active workspace still references it.
export async function archiveByScope(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
): Promise<ArchiveResult> {
  if (request.recoverRetirement) {
    if (!request.operationId || request.scope.kind !== "workspace")
      throw new Error("retirement_recovery_operation_required");
    return recoverWorkspaceRetirement(dependencies, request.operationId, request.scope.workspaceId);
  }

  if (request.operationId) {
    if (
      !dependencies.retirementAuthority ||
      !dependencies.getWorkspace ||
      request.scope.kind !== "workspace"
    )
      throw new Error("canonical_retirement_operation_unavailable");
    const { operationId, ...withoutOperation } = request;
    return withCallerRetirementOperation({
      authority: dependencies.retirementAuthority,
      operationId,
      workspaceId: request.scope.workspaceId,
      getRecord: dependencies.getWorkspace,
      backingPaths: async (record) => [
        record.cwd,
        record.worktreeRoot ?? record.cwd,
        (await resolveWorkspaceBackingDirectory(record, dependencies)).path,
      ],
      run: (expectedNativeGeneration) =>
        archiveCanonicalByScope(
          dependencies,
          withoutOperation,
          operationId.toLowerCase(),
          expectedNativeGeneration,
        ),
    });
  }
  return archiveCanonicalByScope(dependencies, request);
}
async function archiveCanonicalByScope(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
  operationId?: string,
  expectedNativeGeneration?: string,
): Promise<ArchiveResult> {
  if (dependencies.retirementAuthority) {
    const nativeInventory = dependencies.listRetirementRecords;
    if (!nativeInventory || !dependencies.getWorkspace)
      throw new Error("canonical_native_inventory_required");
    const initial = await resolveArchiveTarget(dependencies, request.scope);
    const initialInventory = await nativeInventory();
    const initialIds =
      request.scope.kind === "workspace" ? [request.scope.workspaceId] : initial.workspaceIds;
    const initialRecords = initialInventory.filter((record) =>
      initialIds.includes(record.workspaceId),
    );
    return serializeWorkspaceBacking(
      {
        paths: [
          ...(initial.backing ? [initial.backing.path] : []),
          ...initialRecords.flatMap((record) => [record.cwd, record.worktreeRoot ?? record.cwd]),
        ],
        keys: [
          ...initialIds.map((id) =>
            nativeTransitionKey(dependencies.retirementAuthority!.options.home, "workspace", id),
          ),
          ...(request.scope.kind === "project"
            ? [
                nativeTransitionKey(
                  dependencies.retirementAuthority!.options.home,
                  "project",
                  request.scope.projectId,
                ),
              ]
            : []),
        ],
      },
      async () => {
        const target = await resolveArchiveTarget(dependencies, request.scope);
        if (request.scope.kind === "worktree" && !target.workspaceIds.length)
          throw new Error("Canonical retirement requires an exact native workspace footprint");
        const ids =
          request.scope.kind === "workspace" ? [request.scope.workspaceId] : target.workspaceIds;
        const inventory = await nativeInventory();
        const records = await Promise.all(
          ids.map(async (id) => {
            const record =
              inventory.find((candidate) => candidate.workspaceId === id) ??
              (await dependencies.getWorkspace?.(id));
            if (!record)
              throw new Error("Canonical retirement requires native identity and creation time");
            return record;
          }),
        );
        if (expectedNativeGeneration && nativeGeneration(records) !== expectedNativeGeneration)
          throw new Error("retirement_operation_generation_changed");
        if (nativeGeneration(records) !== nativeGeneration(initialRecords))
          throw new Error("retirement_native_footprint_changed");
        if (
          (request.scope.kind === "worktree" ||
            (request.scope.kind === "project" && request.scope.workspaceIds)) &&
          request.scope.expectedBackingGeneration !== nativeGeneration(records)
        )
          throw new Error("canonical_backing_generation_required_or_changed");
        const backing = target.backing?.path ?? records[0].cwd;
        return retireCanonicalWorkspace({
          operationId,
          expectedProjectId: request.scope.kind === "project" ? request.scope.projectId : undefined,
          authority: dependencies.retirementAuthority!,
          records,
          backing,
          nativeInventory,
          getRecord: async (id) => (await dependencies.getWorkspace?.(id)) ?? null,
          assertHolds: async (id) => {
            await dependencies.assertWorkspaceAutomationAllowed?.(id);
          },
          run: () =>
            runWithGitCommandPriority("high", () =>
              archiveResolvedTarget(dependencies, request, target),
            ),
        });
      },
    );
  }
  if (dependencies.paseoHome) await assertWorkspaceRetirementAllowed(dependencies.paseoHome);
  return runWithGitCommandPriority("high", () => archiveByScopeWithPriority(dependencies, request));
}

async function archiveByScopeWithPriority(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
): Promise<ArchiveResult> {
  const target = await resolveArchiveTarget(dependencies, request.scope);
  return archiveResolvedTarget(dependencies, request, target);
}

async function archiveResolvedTarget(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
  target: ArchiveTarget,
): Promise<ArchiveResult> {
  const targetWorkspaceIds = target.workspaceIds;

  await workspaceRetirementStep("stop-setups", () =>
    stopWorkspaceSetups(dependencies, target.setupWorkspaceIds, request.requestId),
  );

  if (targetWorkspaceIds.length > 0) {
    dependencies.markWorkspaceArchiving(targetWorkspaceIds, new Date().toISOString());
  }

  let removedDirectory = false;
  let directoryLeftBehind: ArchiveResult["directoryLeftBehind"];

  try {
    if (targetWorkspaceIds.length > 0) {
      await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
    }

    const { archivedAgents, archivedWorkspaceIds } = await archiveTargetRecords(
      dependencies,
      targetWorkspaceIds,
      request.requestId,
    );

    if (hasWorkspaceRetirement()) {
      if (archivedWorkspaceIds.length !== targetWorkspaceIds.length)
        throw new Error("Retirement native teardown remains partial");
      await commitWorkspaceRetirementArchive();
    }

    if (target.backing?.mainRepoRoot) {
      try {
        // Records are already archived. A stalled refresh must not hold cleanup
        // or the scheduled runner's completion/admission release indefinitely.
        await withTimeout({
          promise: dependencies.workspaceGitService.getSnapshot(target.backing.mainRepoRoot, {
            force: true,
            reason: "archive-worktree",
          }),
          timeoutMs: POST_ARCHIVE_SNAPSHOT_TIMEOUT_MS,
          label: "post-archive workspace git snapshot",
        });
      } catch (error) {
        dependencies.sessionLogger?.warn(
          { err: error, cwd: target.backing.mainRepoRoot, requestId: request.requestId },
          "Failed to force-refresh workspace git snapshot after archiving",
        );
      }
    }

    if (target.backing !== null) {
      const removal = await maybeRemoveDirectory(
        dependencies,
        request,
        target,
        archivedWorkspaceIds,
      );
      removedDirectory = removal.removedDirectory;
      directoryLeftBehind = removal.directoryLeftBehind;
    }

    return {
      archivedAgentIds: Array.from(archivedAgents),
      archivedWorkspaceIds,
      removedDirectory,
      ...(hasWorkspaceRetirement() && target.backing !== null
        ? {
            slotKept:
              !removedDirectory &&
              (await stat(target.backing.path)
                .then(() => true)
                .catch((error) => {
                  if (error.code === "ENOENT") return false;
                  throw error;
                })),
          }
        : {}),
      ...(directoryLeftBehind ? { directoryLeftBehind } : {}),
    };
  } finally {
    if (targetWorkspaceIds.length > 0) {
      dependencies.clearWorkspaceArchiving(targetWorkspaceIds);
      await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
    }
  }
}

async function activeNativeReferences(
  dependencies: Pick<ArchiveDependencies, "listRetirementRecords" | "listActiveWorkspaces">,
): Promise<ActiveWorkspaceRef[]> {
  const records =
    (await dependencies.listRetirementRecords?.()) ?? (await dependencies.listActiveWorkspaces());
  return records.filter((record) => !("archivedAt" in record && record.archivedAt));
}

async function resolveArchiveTarget(
  dependencies: ArchiveDependencies,
  scope: ArchiveScope,
): Promise<ArchiveTarget> {
  const activeWorkspaces = await activeNativeReferences(dependencies);
  if (scope.kind === "project")
    return resolveProjectArchiveTarget(dependencies, scope, activeWorkspaces);

  if (scope.kind === "workspace") {
    const workspaceId = scope.workspaceId;
    const record =
      (await dependencies.getWorkspace?.(workspaceId)) ??
      activeWorkspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) {
      dependencies.sessionLogger?.warn(
        { workspaceId },
        "Workspace not found for archive-by-scope; skipping",
      );
      return { backing: null, teardownTargets: [], setupWorkspaceIds: [], workspaceIds: [] };
    }
    const isArchived = "archivedAt" in record && Boolean(record.archivedAt);
    return {
      backing: await resolveWorkspaceBackingDirectory(record, dependencies),
      teardownTargets: isArchived ? [] : [{ workspaceId, cwd: record.cwd }],
      setupWorkspaceIds: [workspaceId],
      workspaceIds: isArchived ? [] : [workspaceId],
    };
  }

  const backing = await resolveBackingDirectory(scope.targetPath, dependencies);
  const matchesBackingDirectory = createRealpathAwarePathMatcher(backing.path);
  const targetWorkspaces = (
    await Promise.all(
      activeWorkspaces.map(async (workspace) => {
        const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
        return matchesBackingDirectory(backingDirectory.path) ? workspace : null;
      }),
    )
  ).filter((workspace): workspace is ActiveWorkspaceRef => workspace !== null);
  const recordedId = await dependencies.findWorkspaceIdForCwd(backing.path);
  const recorded = recordedId ? await dependencies.getWorkspace?.(recordedId) : null;
  const record =
    targetWorkspaces.find((workspace) => workspace.kind === "worktree") ??
    (recorded && matchesBackingDirectory(recorded.worktreeRoot ?? recorded.cwd)
      ? recorded
      : null) ??
    targetWorkspaces[0];
  return {
    backing: record ? await resolveWorkspaceBackingDirectory(record, dependencies) : backing,
    teardownTargets:
      targetWorkspaces.length > 0
        ? targetWorkspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            cwd: workspace.cwd,
          }))
        : [{ workspaceId: null, cwd: scope.targetPath }],
    setupWorkspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
    workspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
  };
}

async function resolveProjectArchiveTarget(
  dependencies: ArchiveDependencies,
  scope: Extract<ArchiveScope, { kind: "project" }>,
  activeWorkspaces: ActiveWorkspaceRef[],
): Promise<ArchiveTarget> {
  if (scope.workspaceIds) {
    const inventory = await dependencies.listRetirementRecords?.();
    if (!inventory) throw new Error("canonical_native_inventory_required");
    for (const id of scope.workspaceIds)
      if (
        !inventory.some(
          (record) => record.workspaceId === id && record.projectId === scope.projectId,
        )
      )
        throw new Error("project_retirement_footprint_changed");
    return {
      backing: null,
      teardownTargets: [],
      setupWorkspaceIds: scope.workspaceIds,
      workspaceIds: scope.workspaceIds,
    };
  }
  const records = await Promise.all(
    activeWorkspaces.map((workspace) => dependencies.getWorkspace?.(workspace.workspaceId)),
  );
  const ids = records.flatMap((record) =>
    record?.projectId === scope.projectId ? [record.workspaceId] : [],
  );
  return { backing: null, teardownTargets: [], setupWorkspaceIds: ids, workspaceIds: ids };
}

async function stopWorkspaceSetups(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
  requestId: string,
): Promise<void> {
  if (!dependencies.stopWorkspaceSetup) {
    return;
  }
  const results = await Promise.allSettled(
    workspaceIds.map((workspaceId) => dependencies.stopWorkspaceSetup!(workspaceId)),
  );
  for (const [index, result] of results.entries()) {
    if (result?.status === "rejected") {
      if (hasWorkspaceRetirement()) throw result.reason;
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId: workspaceIds[index], requestId },
        "Failed to stop workspace setup during archive; continuing",
      );
    }
  }
}

async function resolveWorkspaceBackingDirectory(
  workspace: ActiveWorkspaceRef,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<BackingDirectory> {
  if (workspace.isPaseoOwnedWorktree === false) {
    return {
      path: resolve(workspace.worktreeRoot ?? workspace.cwd),
      isPaseoOwnedWorktree: false,
      expectsPaseoOwnership: false,
      registryProven: false,
      mainRepoRoot: workspace.mainRepoRoot ?? null,
      paseoWorktreesRoot: null,
    };
  }
  if (workspace.isPaseoOwnedWorktree && workspace.worktreeRoot && workspace.mainRepoRoot) {
    return {
      path: resolve(workspace.worktreeRoot),
      isPaseoOwnedWorktree: true,
      expectsPaseoOwnership: true,
      registryProven: true,
      mainRepoRoot: workspace.mainRepoRoot,
      paseoWorktreesRoot: null,
    };
  }
  if (workspace.kind !== "worktree") {
    return {
      path: resolve(workspace.cwd),
      isPaseoOwnedWorktree: false,
      expectsPaseoOwnership: false,
      registryProven: false,
      mainRepoRoot: workspace.mainRepoRoot ?? null,
      paseoWorktreesRoot: null,
    };
  }

  // COMPAT(archiveMissingWorkspacePlacement): worktree records created before v0.1.110
  // lack durable backing ownership; remove filesystem discovery after 2027-01-17.
  const backing = await resolveBackingDirectory(
    workspace.worktreeRoot ?? workspace.cwd,
    dependencies,
  );
  return { ...backing, mainRepoRoot: workspace.mainRepoRoot ?? backing.mainRepoRoot };
}

async function resolveBackingDirectory(
  cwd: string,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<BackingDirectory> {
  const options = {
    paseoHome: dependencies.paseoHome,
    worktreesRoot: dependencies.paseoWorktreesBaseRoot,
  };
  const ownership = await isPaseoOwnedWorktreeCwd(cwd, options);
  return {
    path: resolve(ownership.allowed && ownership.worktreePath ? ownership.worktreePath : cwd),
    isPaseoOwnedWorktree: ownership.allowed,
    expectsPaseoOwnership: true,
    registryProven: false,
    mainRepoRoot: ownership.repoRoot ?? null,
    paseoWorktreesRoot: ownership.worktreeRoot ?? null,
  };
}

async function archiveTargetRecords(
  dependencies: ArchiveDependencies,
  targetWorkspaceIds: string[],
  requestId: string,
): Promise<{ archivedAgents: Set<string>; archivedWorkspaceIds: string[] }> {
  const archivedAgents = new Set<string>();
  const archivedWorkspaceIds: string[] = [];

  const results = await Promise.allSettled(
    targetWorkspaceIds.map(async (workspaceId) => {
      const agents = await archiveWorkspaceContents(dependencies, workspaceId);
      await workspaceRetirementStep(`native-archive:${workspaceId}`, () =>
        dependencies.archiveWorkspaceRecord(workspaceId),
      );
      return { workspaceId, agents };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      archivedWorkspaceIds.push(result.value.workspaceId);
      for (const agentId of result.value.agents) {
        archivedAgents.add(agentId);
      }
    } else {
      dependencies.sessionLogger?.warn(
        { err: result.reason, requestId },
        "archiveByScope workspace teardown failed; continuing",
      );
    }
  }

  return { archivedAgents, archivedWorkspaceIds };
}

async function maybeRemoveDirectory(
  dependencies: ArchiveDependencies,
  request: Pick<ArchiveByScopeRequest, "requestId">,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<{
  removedDirectory: boolean;
  directoryLeftBehind?: { path: string; reason: string };
}> {
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree) {
    // Missing ownership proof for a worktree-backed directory: the record
    // still archives, but the directory is left in place and surfaced.
    // Never delete an unproven directory.
    if (backing?.expectsPaseoOwnership) {
      const reason =
        "no ownership proof (not under the Paseo worktrees root, no paseo/worktree.json marker, no registry record)";
      dependencies.sessionLogger?.warn(
        { targetPath: backing.path, requestId: request.requestId },
        `Worktree directory left in place during archive: ${reason}`,
      );
      return {
        removedDirectory: false,
        directoryLeftBehind: { path: backing.path, reason },
      };
    }
    return { removedDirectory: false };
  }

  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  const teardownTargets = target.teardownTargets.filter(
    (teardownTarget) =>
      teardownTarget.workspaceId === null || archivedWorkspaceIdSet.has(teardownTarget.workspaceId),
  );

  if (hasWorkspaceRetirement()) {
    const active = await dependencies.listActiveWorkspaces();
    if (
      !(await isDirectoryUnreferenced(active, backing.path, archivedWorkspaceIdSet, dependencies))
    )
      return {
        removedDirectory: false,
        directoryLeftBehind: { path: backing.path, reason: "shared_backing_retained" },
      };
    if (!(await retirementSourceIsCleanAndLanded(backing.path, backing.mainRepoRoot)))
      return {
        removedDirectory: false,
        directoryLeftBehind: { path: backing.path, reason: "source_preserved" },
      };
  }
  try {
    const allowedTeardownTargets = await filterAllowedTeardownTargets(
      dependencies,
      teardownTargets,
    );
    for (const teardownTarget of uniqueTeardownTargets(allowedTeardownTargets)) {
      await workspaceRetirementStep(`path-teardown:${teardownTarget.cwd}`, () =>
        withWorkspaceRetirementHook(
          {
            workspaceId: teardownTarget.workspaceId,
            worktreePath: backing.path,
            teardownCwd: teardownTarget.cwd,
          },
          (retirementBinding, retirementHome) =>
            runWorktreeTeardownCommands({
              worktreePath: backing.path,
              teardownCwd: teardownTarget.cwd,
              repoRootPath: backing.mainRepoRoot ?? undefined,
              retirementBinding,
              retirementHome,
            }),
        ),
      );
    }
  } catch (error) {
    if (error instanceof WorktreeTeardownError) {
      dependencies.sessionLogger?.warn(
        { err: error, targetPath: backing.path, requestId: request.requestId },
        "Worktree teardown failed during archive; workspace already archived",
      );
      return { removedDirectory: false };
    }
    throw error;
  }

  const remainingActive = await dependencies.listActiveWorkspaces();
  if (
    !(await isDirectoryUnreferenced(
      remainingActive,
      backing.path,
      new Set(archivedWorkspaceIds),
      dependencies,
    ))
  ) {
    return { removedDirectory: false };
  }

  try {
    if (
      hasWorkspaceRetirement() &&
      !(await retirementSourceIsCleanAndLanded(backing.path, backing.mainRepoRoot))
    )
      return {
        removedDirectory: false,
        directoryLeftBehind: { path: backing.path, reason: "source_changed_before_removal" },
      };
    await workspaceRetirementStep("remove-directory", () =>
      deletePaseoWorktree({
        cwd: backing.mainRepoRoot,
        worktreePath: backing.path,
        teardownCwds: [],
        worktreesRoot: backing.paseoWorktreesRoot ?? undefined,
        paseoHome: dependencies.paseoHome,
        worktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
        registryProven: backing.registryProven,
        ...(hasWorkspaceRetirement() ? { requireCleanRemoval: true as const } : {}),
      }),
    );
    dependencies.workspaceGitService.invalidateWorktrees();
    dependencies.github.invalidate({ cwd: backing.path });
    return { removedDirectory: true };
  } catch (error) {
    if (canonicalRemovalMustRefuse(error)) throw error;
    dependencies.sessionLogger?.warn(
      { err: error, targetPath: backing.path, requestId: request.requestId },
      "Worktree disk removal failed during archive; workspace already archived",
    );
    return { removedDirectory: false };
  }
}

function canonicalRemovalMustRefuse(error: unknown): boolean {
  return (
    hasWorkspaceRetirement() &&
    (error instanceof WorkspaceLayoutRefusal || error instanceof GitCommandTimeoutError)
  );
}

async function filterAllowedTeardownTargets(
  dependencies: ArchiveDependencies,
  targets: Array<{ workspaceId: string | null; cwd: string }>,
): Promise<Array<{ workspaceId: string | null; cwd: string }>> {
  const allowed: Array<{ workspaceId: string | null; cwd: string }> = [];
  const blockedCwds: string[] = [];
  for (const target of targets) {
    try {
      if (target.workspaceId)
        await dependencies.assertWorkspaceAutomationAllowed?.(target.workspaceId);
      allowed.push(target);
    } catch (error) {
      if (!(error instanceof WorkspaceAutomationBlockedError)) throw error;
      blockedCwds.push(target.cwd);
    }
  }
  return allowed.filter(
    (target) => !blockedCwds.some((cwd) => createRealpathAwarePathMatcher(cwd)(target.cwd)),
  );
}

function uniqueTeardownTargets<T extends { cwd: string }>(targets: T[]): T[] {
  const unique: T[] = [];
  for (const candidate of targets) {
    if (!unique.some((existing) => createRealpathAwarePathMatcher(existing.cwd)(candidate.cwd))) {
      unique.push(candidate);
    }
  }
  return unique;
}

export type ArchiveWorkspaceContentsDependencies = Pick<
  ArchiveDependencies,
  "agentManager" | "agentStorage" | "killTerminalsForWorkspace" | "sessionLogger"
>;

// Tears down everything OWNED by a single workspace record: its live agents,
// its persisted-but-not-running agent snapshots, and its terminals. Scoped by
// workspaceId so a sibling workspace sharing the same directory is untouched.
// Returns the set of archived agent ids.
export async function archiveWorkspaceContents(
  dependencies: ArchiveWorkspaceContentsDependencies,
  workspaceId: string,
): Promise<Set<string>> {
  const archivedAgents = new Set<string>();

  const liveAgents = dependencies.agentManager
    .listAgents({ includeInternal: true })
    .filter((agent) => agent.workspaceId === workspaceId);
  for (const agent of liveAgents) {
    archivedAgents.add(agent.id);
  }

  let storedRecords: StoredAgentRecord[] = [];
  try {
    storedRecords = await dependencies.agentStorage.listByWorkspace(workspaceId);
  } catch (error) {
    if (hasWorkspaceRetirement()) throw error;
    dependencies.sessionLogger?.warn(
      { err: error, workspaceId },
      "Failed to list stored agents during workspace archive; continuing",
    );
  }
  const matchingStoredRecords = storedRecords;
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
  }

  const archivedAt = new Date().toISOString();
  const agentIdsToArchive = new Set([
    ...liveAgents.map((agent) => agent.id),
    ...matchingStoredRecords.filter((record) => !record.archivedAt).map((record) => record.id),
  ]);
  const archiveResults = await Promise.allSettled([
    ...[...agentIdsToArchive].map((agentId) =>
      dependencies.agentManager.getAgent(agentId)
        ? workspaceRetirementStep(`agent:${agentId}`, () =>
            dependencies.agentManager.archiveAgent(agentId),
          )
        : workspaceRetirementStep(`snapshot:${agentId}`, () =>
            dependencies.agentManager.archiveSnapshot(agentId, archivedAt),
          ),
    ),
    workspaceRetirementStep(`terminals:${workspaceId}`, () =>
      dependencies.killTerminalsForWorkspace(workspaceId),
    ),
  ]);

  for (const result of archiveResults) {
    if (result.status === "rejected") {
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId },
        "Workspace archive teardown step failed; continuing",
      );
    }
  }

  // A failed agent archive must not authorize archiving its workspace or
  // deleting the backing directory. Terminal cleanup remains best-effort.
  const failedArchive = archiveResults
    .slice(0, agentIdsToArchive.size)
    .find((result) => result.status === "rejected");
  if (failedArchive?.status === "rejected") throw failedArchive.reason;
  if (hasWorkspaceRetirement()) {
    const failed = archiveResults.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  return archivedAgents;
}

// True when, after archiving
// the in-scope records, no active workspace still points at targetDir. Derived
// from records each call — no stored counter.
async function isDirectoryUnreferenced(
  activeWorkspaces: ActiveWorkspaceRef[],
  targetDir: string,
  archivedWorkspaceIds: ReadonlySet<string>,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<boolean> {
  const target = resolve(targetDir);
  const matchesTarget = createRealpathAwarePathMatcher(target);
  for (const workspace of activeWorkspaces) {
    if (archivedWorkspaceIds.has(workspace.workspaceId)) continue;
    const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
    if (matchesTarget(backingDirectory.path)) return false;
  }
  return true;
}

export async function killTerminalsForWorkspace(
  dependencies: KillTerminalsForWorkspaceDependencies,
  workspaceId: string,
): Promise<void> {
  const terminalManager = dependencies.terminalManager;
  if (!terminalManager) {
    return;
  }

  const terminalIds: string[] = [];
  const terminalLists = await Promise.all(
    terminalManager.listDirectories().map(async (terminalCwd) => {
      try {
        return await terminalManager.getTerminals(terminalCwd, { workspaceId });
      } catch (error) {
        dependencies.sessionLogger.warn(
          { err: error, cwd: terminalCwd },
          "Failed to enumerate workspace terminals during archive",
        );
        return [];
      }
    }),
  );
  for (const terminals of terminalLists) {
    for (const terminal of terminals) {
      if (terminal.workspaceId === workspaceId) {
        terminalIds.push(terminal.id);
      }
    }
  }

  if (terminalIds.length === 0) {
    return;
  }

  await Promise.allSettled(
    terminalIds.map(async (terminalId) => {
      try {
        dependencies.detachTerminalStream?.(terminalId, { emitExit: true });
        await terminalManager.killTerminalAndWait(terminalId, {
          gracefulTimeoutMs: 2000,
          forceTimeoutMs: 1500,
        });
      } catch (error) {
        dependencies.sessionLogger.warn(
          { err: error, terminalId },
          "Terminal kill escalation failed during archive; proceeding anyway",
        );
      }
    }),
  );
}

// Archiving the last workspace of a project leaves the project record active.
// The user removes the project explicitly, so we never archive the parent here.
export async function archivePersistedWorkspaceRecord(input: {
  workspaceId: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "archive">;
  archivedAt?: string;
  context?: WorkspaceArchiveContext;
}): Promise<PersistedWorkspaceRecord | null> {
  const existingWorkspace = await input.workspaceRegistry.get(input.workspaceId);
  if (!existingWorkspace) {
    return null;
  }

  if (existingWorkspace.archivedAt) {
    return existingWorkspace;
  }

  const archivedAt = input.archivedAt ?? new Date().toISOString();
  await input.workspaceRegistry.archive(input.workspaceId, archivedAt, input.context);

  return existingWorkspace;
}

const execFileAsync = promisify(execFile);
async function retirementSourceIsCleanAndLanded(
  worktree: string,
  mainRepo: string | null,
): Promise<boolean> {
  if (!mainRepo) return false;
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", worktree, "status", "--porcelain", "--untracked-files=all"],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    if (status.trim()) return false;
    const { stdout: base } = await execFileAsync("git", ["-C", mainRepo, "rev-parse", "HEAD"], {
      timeout: 10000,
    });
    try {
      await execFileAsync(
        "git",
        ["-C", worktree, "merge-base", "--is-ancestor", "HEAD", base.trim()],
        { timeout: 10000 },
      );
      return true;
    } catch (error) {
      // Exit 1 means non-ancestry; other errors cannot authorize source removal.
      if ((error as { code?: unknown }).code !== 1) return false;
    }
    const { stdout: branchRef } = await execFileAsync(
      "git",
      ["-C", mainRepo, "symbolic-ref", "--quiet", "HEAD"],
      { timeout: 10000 },
    );
    const { stdout: upstreamRemote } = await execFileAsync(
      "git",
      ["-C", mainRepo, "for-each-ref", "--format=%(upstream:remotename)", branchRef.trim()],
      { timeout: 10000 },
    );
    const { stdout: remoteNames } = await execFileAsync("git", ["-C", mainRepo, "remote"], {
      timeout: 10000,
    });
    const remotes = remoteNames.trim().split("\n").filter(Boolean);
    let remote: string | null = null;
    if (remotes.includes(upstreamRemote.trim())) remote = upstreamRemote.trim();
    else if (remotes.length === 1) remote = remotes[0];
    if (!remote) return false;
    const { stdout: defaultRef } = await execFileAsync(
      "git",
      ["-C", mainRepo, "symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
      { timeout: 10000 },
    );
    // A personal upstream is not a merged base. Trust only the local symbolic remote default.
    if (
      !defaultRef.trim().startsWith(`refs/remotes/${remote}/`) ||
      defaultRef.trim() === `refs/remotes/${remote}/HEAD`
    )
      return false;
    const { stdout: mergedBase } = await execFileAsync(
      "git",
      ["-C", mainRepo, "rev-parse", "--verify", `${defaultRef.trim()}^{commit}`],
      { timeout: 10000 },
    );
    await execFileAsync(
      "git",
      ["-C", worktree, "merge-base", "--is-ancestor", "HEAD", mergedBase.trim()],
      { timeout: 10000 },
    );
    return true;
  } catch {
    return false;
  } // Failure retains the directory; it never authorizes forced deletion.
}

export async function recoverWorkspaceRetirement(
  dependencies: ArchiveDependencies,
  operationId: string,
  expectedWorkspaceId?: string,
  confirmation?: { expectedBackingGeneration?: string; effectsClosed?: boolean },
): Promise<ArchiveResult> {
  const authority = dependencies.retirementAuthority;
  if (!authority || !dependencies.getWorkspace || !dependencies.listRetirementRecords)
    throw new Error("canonical_retirement_recovery_required");
  return recoverCanonicalWorkspaceRetirement({
    authority,
    operationId,
    expectedWorkspaceId,
    ...confirmation,
    getRecord: dependencies.getWorkspace,
    nativeInventory: dependencies.listRetirementRecords,
    assertHolds: async (id) => {
      await dependencies.assertWorkspaceAutomationAllowed?.(id);
    },
    retryDirectory: async (records, backingPath) => {
      const backing = await resolveWorkspaceBackingDirectory(records[0], dependencies);
      if (resolve(backing.path) !== resolve(backingPath))
        throw new Error("retirement_backing_generation_changed");
      const outcome = await maybeRemoveDirectory(
        dependencies,
        { requestId: `recover:${operationId}` },
        {
          backing,
          workspaceIds: records.map((row) => row.workspaceId),
          teardownTargets: [],
          setupWorkspaceIds: [],
        },
        records.map((row) => row.workspaceId),
      );
      return {
        archivedWorkspaceIds: records.map((row) => row.workspaceId),
        archivedAgentIds: [],
        ...outcome,
      };
    },
  });
}
