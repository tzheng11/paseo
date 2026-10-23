import { resolve } from "node:path";
import type pino from "pino";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import { WORKING_TREE_OBSERVATION_IDLE_GRACE_MS } from "../../workspace-git-observation-policy.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";

interface WorkspaceGitWatchTarget {
  workspaceIds: Set<string>;
  idleTimer: NodeJS.Timeout | null;
}

interface WorkspaceGitWatchState {
  cwd: string;
  lastBranchName: string | null;
  status?: WorkspaceDescriptorPayload["status"];
}

export interface WorkspaceGitObserverMetrics {
  watchedDirectoryCount: number;
  workspaceRecordCount: number;
  subscriptionCount: number;
}

/**
 * Observes a workspace's git state on disk (via WorkspaceGitService) and drives the
 * live update fan-out: branch-change notifications, workspace-card refreshes, and
 * checkout status updates. It owns the per-cwd watch targets and the WorkspaceGitService
 * subscription handles. Filesystem subscriptions are keyed by cwd while descriptor and
 * branch state remain keyed by workspace id, so same-directory workspace records share one
 * watch without sharing identity or teardown lifetime.
 *
 * Branch changes reach `onBranchChanged` from two paths that share `lastBranchName`: the
 * on-disk snapshot listener (handleBranchSnapshot) and the workspace-emit loop's Git runtime
 * projection (recordDescriptorState). Both stay inside this module so the shared state is coherent.
 */
export interface WorkspaceGitObserverService {
  syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void;
  reconcileObservers(
    workspaces: Iterable<
      Pick<WorkspaceDescriptorPayload, "id" | "workspaceDirectory" | "workspaceKind">
    >,
  ): void;
  recordDescriptorState(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): void;
  setFocusedDirectories(cwds: Iterable<string>): void;
  handleBranchSnapshot(cwd: string, branchName: string | null): void;
  getMetrics(): WorkspaceGitObserverMetrics;
  removeForWorkspaceId(workspaceId: string): void;
  dispose(): void;
}

export function createWorkspaceGitObserverService(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitStatusUpdate: (cwd: string, snapshot: WorkspaceGitRuntimeSnapshot) => void;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  logger: pino.Logger;
}): WorkspaceGitObserverService {
  const {
    workspaceGitService,
    emitWorkspaceUpdateForCwd,
    emitStatusUpdate,
    onBranchChanged,
    logger,
  } = deps;

  const watchTargets = new Map<string, WorkspaceGitWatchTarget>();
  const workspaceStates = new Map<string, WorkspaceGitWatchState>();
  const subscriptions = new Map<string, { unsubscribe: () => void; observeWorkingTree: boolean }>();
  let focusedDirectories = new Set<string>();

  function rememberDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    const currentBranch = workspace?.gitRuntime?.currentBranch;
    if (currentBranch !== undefined) {
      state.lastBranchName = currentBranch;
    }
  }

  function removeForCwd(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    const target = watchTargets.get(normalizedCwd);
    if (target?.idleTimer) clearTimeout(target.idleTimer);
    for (const workspaceId of target?.workspaceIds ?? []) {
      workspaceStates.delete(workspaceId);
    }
    watchTargets.delete(normalizedCwd);
    subscriptions.get(normalizedCwd)?.unsubscribe();
    subscriptions.delete(normalizedCwd);
  }

  function removeForWorkspaceId(workspaceId: string): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    workspaceStates.delete(workspaceId);
    const target = watchTargets.get(state.cwd);
    target?.workspaceIds.delete(workspaceId);
    if (target?.workspaceIds.size === 0) {
      removeForCwd(state.cwd);
    } else {
      syncSubscription(state.cwd);
    }
  }

  function handleBranchSnapshot(cwd: string, branchName: string | null): void {
    const target = watchTargets.get(resolve(cwd));
    if (!target) {
      return;
    }

    for (const workspaceId of target.workspaceIds) {
      const state = workspaceStates.get(workspaceId);
      if (!state) {
        continue;
      }
      const previousBranchName = state.lastBranchName;
      if (branchName === previousBranchName) {
        continue;
      }
      state.lastBranchName = branchName;
      onBranchChanged?.(workspaceId, previousBranchName, branchName);
    }
  }

  function syncObserver(
    cwd: string,
    options: {
      isGit: boolean;
      workspaceId: string;
      status?: WorkspaceDescriptorPayload["status"];
    },
  ): void {
    const normalizedCwd = resolve(cwd);
    const currentState = workspaceStates.get(options.workspaceId);
    if (currentState && currentState.cwd !== normalizedCwd) {
      removeForWorkspaceId(options.workspaceId);
    }
    if (!options.isGit) {
      removeForWorkspaceId(options.workspaceId);
      return;
    }

    const target = watchTargets.get(normalizedCwd) ?? {
      workspaceIds: new Set<string>(),
      idleTimer: null,
    };
    watchTargets.set(normalizedCwd, target);
    target.workspaceIds.add(options.workspaceId);
    if (!workspaceStates.has(options.workspaceId)) {
      workspaceStates.set(options.workspaceId, {
        cwd: normalizedCwd,
        lastBranchName: null,
        status: options.status,
      });
    } else if (options.status !== undefined) {
      workspaceStates.get(options.workspaceId)!.status = options.status;
    }

    syncSubscription(normalizedCwd);
  }

  function syncSubscription(normalizedCwd: string, graceExpired = false): void {
    const target = watchTargets.get(normalizedCwd);
    if (!target) return;
    const observeWorkingTree =
      focusedDirectories.has(normalizedCwd) ||
      [...target.workspaceIds].some((id) => workspaceStates.get(id)?.status === "running");
    const previous = subscriptions.get(normalizedCwd);
    if (observeWorkingTree && target.idleTimer) {
      clearTimeout(target.idleTimer);
      target.idleTimer = null;
    }
    if (previous?.observeWorkingTree === observeWorkingTree) return;
    if (!observeWorkingTree && previous?.observeWorkingTree && !graceExpired) {
      target.idleTimer ??= setTimeout(() => {
        target.idleTimer = null;
        syncSubscription(normalizedCwd, true);
      }, WORKING_TREE_OBSERVATION_IDLE_GRACE_MS);
      target.idleTimer.unref?.();
      return;
    }

    let subscription: ReturnType<WorkspaceGitService["registerWorkspace"]>;
    try {
      subscription = workspaceGitService.registerWorkspace(
        { cwd: normalizedCwd, observeWorkingTree },
        (snapshot) => {
          handleBranchSnapshot(normalizedCwd, snapshot.git.currentBranch ?? null);
          void emitWorkspaceUpdateForCwd(normalizedCwd).catch((error) => {
            logger.warn(
              { err: error, cwd: normalizedCwd },
              "Failed to emit workspace update after git branch snapshot",
            );
          });
          emitStatusUpdate(normalizedCwd, snapshot);
        },
      );
    } catch (error) {
      if (!previous) removeForCwd(normalizedCwd);
      throw error;
    }
    // Acquire first so changing demand preserves the shared snapshot and metadata watcher.
    subscriptions.set(normalizedCwd, { unsubscribe: subscription.unsubscribe, observeWorkingTree });
    previous?.unsubscribe();
  }

  function syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void {
    for (const workspace of workspaces) {
      syncObserver(workspace.workspaceDirectory, {
        isGit: workspace.workspaceKind !== "directory",
        workspaceId: workspace.id,
        status: workspace.status,
      });
      rememberDescriptorState(workspace.id, workspace);
    }
  }

  return {
    reconcileObservers(workspaces) {
      const retained = new Map([...workspaces].map((workspace) => [workspace.id, workspace]));
      for (const workspaceId of workspaceStates.keys()) {
        if (!retained.has(workspaceId)) removeForWorkspaceId(workspaceId);
      }
      for (const workspace of retained.values()) {
        syncObserver(workspace.workspaceDirectory, {
          isGit: workspace.workspaceKind !== "directory",
          workspaceId: workspace.id,
        });
      }
    },
    syncObservers,
    recordDescriptorState(workspaceId, nextWorkspace) {
      const state = workspaceStates.get(workspaceId);
      const newBranchName = nextWorkspace?.gitRuntime?.currentBranch;
      if (state && onBranchChanged && newBranchName !== undefined) {
        if (newBranchName !== state.lastBranchName) {
          onBranchChanged(workspaceId, state.lastBranchName, newBranchName);
        }
      }
      rememberDescriptorState(workspaceId, nextWorkspace);
      if (state && nextWorkspace) {
        state.status = nextWorkspace.status;
        syncSubscription(state.cwd);
      }
    },

    setFocusedDirectories(cwds) {
      focusedDirectories = new Set([...cwds].map((cwd) => resolve(cwd)));
      for (const cwd of watchTargets.keys()) syncSubscription(cwd);
    },

    handleBranchSnapshot,

    getMetrics() {
      return {
        watchedDirectoryCount: watchTargets.size,
        workspaceRecordCount: workspaceStates.size,
        subscriptionCount: subscriptions.size,
      };
    },

    removeForWorkspaceId,

    dispose() {
      for (const target of watchTargets.values()) {
        if (target.idleTimer) clearTimeout(target.idleTimer);
      }
      for (const subscription of subscriptions.values()) {
        subscription.unsubscribe();
      }
      subscriptions.clear();
      watchTargets.clear();
      workspaceStates.clear();
    },
  };
}
