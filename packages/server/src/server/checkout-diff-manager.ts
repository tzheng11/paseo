import { type WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type pino from "pino";
import type { SubscribeCheckoutDiffRequest, SessionOutboundMessage } from "./messages.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import { expandTilde } from "../utils/path.js";
import { toCheckoutError } from "./checkout-git-utils.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";

const CHECKOUT_DIFF_WATCH_DEBOUNCE_MS = 150;

type CheckoutDiffWorkspace = Pick<
  WorkspaceGitService,
  "getCheckoutDiff" | "peekSnapshot" | "registerWorkspace" | "requestWorkingTreeWatch"
>;

export type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];

export type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;

export interface CheckoutDiffMetrics {
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
}

interface CheckoutDiffWatchTarget {
  key: string;
  cwd: string;
  diffCwd: string;
  compare: CheckoutDiffCompareInput;
  listeners: Set<(snapshot: CheckoutDiffSnapshotPayload) => void>;
  workingTreeWatchUnsubscribe: (() => void) | null;
  workspaceGitUnsubscribe: (() => void) | null;
  latestWorkspaceStructureFingerprint: string | null;
  latestWorkspaceWorktreeFingerprint: string | null;
  latestWorkspaceForgeFingerprint: string | null;
  debounceTimer: NodeJS.Timeout | null;
  pendingDebounceForce: boolean;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  refreshQueuedForce: boolean;
  latestPayload: CheckoutDiffSnapshotPayload | null;
  latestFingerprint: string | null;
  openPromise: Promise<void> | null;
  initialPromise: Promise<CheckoutDiffSnapshotPayload> | null;
}

export interface CheckoutDiffSubscriptionRequest {
  cwd: string;
  compare: CheckoutDiffCompareInput;
  signal?: AbortSignal;
}

export interface CheckoutDiffSubscription {
  initial: CheckoutDiffSnapshotPayload;
  unsubscribe: () => void;
}

export class CheckoutDiffManager {
  private readonly workspaceGitService: CheckoutDiffWorkspace;
  private readonly targets = new Map<string, CheckoutDiffWatchTarget>();
  private readonly logger: pino.Logger;

  constructor(options: {
    logger: pino.Logger;
    paseoHome: string;
    workspaceGitService: CheckoutDiffWorkspace;
    workspaceRuntimeStore: WorkspaceRuntimeStore;
  }) {
    this.workspaceGitService = options.workspaceGitService;
    this.logger = options.logger;
  }

  async read(
    params: Omit<CheckoutDiffSubscriptionRequest, "signal">,
  ): Promise<CheckoutDiffSnapshotPayload> {
    return runWithGitCommandPriority("high", () =>
      this.computeCheckoutDiffSnapshot(params.cwd, this.normalizeCompare(params.compare)),
    );
  }

  async subscribe(
    params: CheckoutDiffSubscriptionRequest,
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): Promise<CheckoutDiffSubscription> {
    const cwd = params.cwd;
    const compare = this.normalizeCompare(params.compare);
    const target = this.ensureTarget(cwd, compare);
    target.listeners.add(listener);
    target.initialPromise ??= runWithGitCommandPriority("high", () =>
      this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
        diffCwd: target.diffCwd,
        force: true,
        reason: "checkout-diff-initial",
      }),
    ).then((initial) => {
      if (this.isActiveTarget(target)) {
        target.latestPayload = initial;
        target.latestFingerprint = JSON.stringify(initial);
      }
      return initial;
    });
    target.openPromise ??= this.openTarget(target).catch((error: unknown) => {
      if (this.isActiveTarget(target)) {
        this.logger.warn(
          { err: error, cwd: target.cwd },
          "Failed to open checkout diff observation",
        );
      }
    });

    let isSubscribed = true;
    const unsubscribe = () => {
      if (!isSubscribed) {
        return;
      }
      isSubscribed = false;
      params.signal?.removeEventListener("abort", unsubscribe);
      this.removeListener(target, listener);
    };
    params.signal?.addEventListener("abort", unsubscribe, { once: true });
    if (params.signal?.aborted) {
      unsubscribe();
    }

    try {
      // Observation registration retains demand in parallel. The first explicit
      // read must not sit behind ignore inventories or native canary deadlines.
      const initial = target.latestPayload ?? (await target.initialPromise);
      return { initial, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  scheduleRefreshForCwd(cwd: string): void {
    const resolvedCwd = expandTilde(cwd);
    for (const target of this.targets.values()) {
      if (target.cwd !== resolvedCwd && target.diffCwd !== resolvedCwd) {
        continue;
      }
      this.scheduleTargetRefresh(target);
    }
  }

  getMetrics(): CheckoutDiffMetrics {
    let checkoutDiffSubscriptionCount = 0;

    for (const target of this.targets.values()) {
      checkoutDiffSubscriptionCount += target.listeners.size;
    }

    return {
      checkoutDiffTargetCount: this.targets.size,
      checkoutDiffSubscriptionCount,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.closeTarget(target);
    }
    this.targets.clear();
  }

  private normalizeCompare(compare: CheckoutDiffCompareInput): CheckoutDiffCompareInput {
    const ignoreWhitespace = compare.ignoreWhitespace === true;
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted", ignoreWhitespace };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    return trimmedBaseRef
      ? { mode: compare.mode, baseRef: trimmedBaseRef, ignoreWhitespace }
      : { mode: compare.mode, ignoreWhitespace };
  }

  private buildTargetKey(cwd: string, compare: CheckoutDiffCompareInput): string {
    return JSON.stringify([
      cwd,
      compare.mode,
      compare.mode !== "uncommitted" ? (compare.baseRef ?? "") : "",
      compare.ignoreWhitespace === true,
    ]);
  }

  private closeTarget(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    target.workingTreeWatchUnsubscribe?.();
    target.workingTreeWatchUnsubscribe = null;
    target.workspaceGitUnsubscribe?.();
    target.workspaceGitUnsubscribe = null;
    target.listeners.clear();
  }

  private isActiveTarget(target: CheckoutDiffWatchTarget): boolean {
    return this.targets.get(target.key) === target && target.listeners.size > 0;
  }

  private rememberWorkspaceSnapshot(
    target: CheckoutDiffWatchTarget,
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): void {
    if (!this.isActiveTarget(target)) return;
    const structureFingerprint = JSON.stringify({
      isGit: snapshot.git.isGit,
      repoRoot: snapshot.git.repoRoot,
      mainRepoRoot: snapshot.git.mainRepoRoot,
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isPaseoOwnedWorktree: snapshot.git.isPaseoOwnedWorktree,
      baseRef: snapshot.git.baseRef,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
      hasRemote: snapshot.git.hasRemote,
    });
    const worktreeFingerprint = JSON.stringify({
      isDirty: snapshot.git.isDirty,
      diffStat: snapshot.git.diffStat,
    });
    const forgeFingerprint = JSON.stringify(snapshot.forge);
    const previousStructureFingerprint = target.latestWorkspaceStructureFingerprint;
    const previousWorktreeFingerprint = target.latestWorkspaceWorktreeFingerprint;
    const previousForgeFingerprint = target.latestWorkspaceForgeFingerprint;
    target.latestWorkspaceStructureFingerprint = structureFingerprint;
    target.latestWorkspaceWorktreeFingerprint = worktreeFingerprint;
    target.latestWorkspaceForgeFingerprint = forgeFingerprint;

    if (previousStructureFingerprint === null) {
      return;
    }
    const structureChanged = structureFingerprint !== previousStructureFingerprint;
    const worktreeChanged = worktreeFingerprint !== previousWorktreeFingerprint;
    const forgeChanged = forgeFingerprint !== previousForgeFingerprint;
    if (structureChanged || (!worktreeChanged && !forgeChanged)) {
      this.scheduleTargetRefresh(target, false);
    }
  }

  private removeListener(
    target: CheckoutDiffWatchTarget,
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): void {
    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }
    this.closeTarget(target);
    if (this.targets.get(target.key) === target) {
      this.targets.delete(target.key);
    }
  }

  private scheduleTargetRefresh(target: CheckoutDiffWatchTarget, force = true): void {
    if (!this.isActiveTarget(target)) return;
    target.pendingDebounceForce ||= force;
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      const pendingForce = target.pendingDebounceForce;
      target.pendingDebounceForce = false;
      void this.refreshTarget(target, pendingForce);
    }, CHECKOUT_DIFF_WATCH_DEBOUNCE_MS);
  }

  private async computeCheckoutDiffSnapshot(
    cwd: string,
    compare: CheckoutDiffCompareInput,
    options?: { diffCwd?: string; force?: boolean; reason?: string },
  ): Promise<CheckoutDiffSnapshotPayload> {
    const diffCwd = options?.diffCwd ?? cwd;
    try {
      const diffResult = await this.workspaceGitService.getCheckoutDiff(
        diffCwd,
        {
          mode: compare.mode,
          baseRef: compare.baseRef,
          ignoreWhitespace: compare.ignoreWhitespace,
          includeStructured: true,
        },
        options?.force
          ? { force: true, reason: options.reason ?? "checkout-diff-refresh" }
          : undefined,
      );
      if (diffResult.diffTooLarge) {
        return {
          cwd,
          files: [],
          diffTooLarge: true,
          error: toCheckoutError(new Error("Diff too large to display")),
        };
      }
      const files = [...(diffResult.structured ?? [])];
      files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
      });
      return {
        cwd,
        files,
        error: null,
      };
    } catch (error) {
      return {
        cwd,
        files: [],
        error: toCheckoutError(error),
      };
    }
  }

  private async refreshTarget(target: CheckoutDiffWatchTarget, force: boolean): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      target.refreshQueuedForce ||= force;
      return;
    }

    target.refreshPromise = (async () => {
      await target.initialPromise;
      if (!this.isActiveTarget(target)) return;
      let currentForce = force;
      do {
        target.refreshQueued = false;
        target.refreshQueuedForce = false;
        const snapshot = await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
          diffCwd: target.diffCwd,
          force: currentForce,
          ...(currentForce ? { reason: "working-tree-watch" } : {}),
        });
        if (!this.isActiveTarget(target)) return;
        target.latestPayload = snapshot;
        const fingerprint = JSON.stringify(snapshot);
        if (fingerprint !== target.latestFingerprint) {
          target.latestFingerprint = fingerprint;
          for (const listener of target.listeners) {
            listener(snapshot);
          }
        }
        currentForce = target.refreshQueuedForce;
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  private ensureTarget(cwd: string, compare: CheckoutDiffCompareInput): CheckoutDiffWatchTarget {
    const targetKey = this.buildTargetKey(cwd, compare);
    const existing = this.targets.get(targetKey);
    if (existing) {
      return existing;
    }

    const target: CheckoutDiffWatchTarget = {
      key: targetKey,
      cwd,
      diffCwd: cwd,
      compare,
      listeners: new Set(),
      workingTreeWatchUnsubscribe: null,
      workspaceGitUnsubscribe: null,
      latestWorkspaceStructureFingerprint: null,
      latestWorkspaceWorktreeFingerprint: null,
      latestWorkspaceForgeFingerprint: null,
      debounceTimer: null,
      pendingDebounceForce: false,
      refreshPromise: null,
      refreshQueued: false,
      refreshQueuedForce: false,
      latestPayload: null,
      latestFingerprint: null,
      openPromise: null,
      initialPromise: null,
    };
    this.targets.set(targetKey, target);
    return target;
  }

  private async openTarget(target: CheckoutDiffWatchTarget): Promise<void> {
    const cached = this.workspaceGitService.peekSnapshot(target.cwd);
    if (cached) this.rememberWorkspaceSnapshot(target, cached);
    // Keep the shared Git metadata-to-working-tree link for every comparison.
    const workspaceSubscription = this.workspaceGitService.registerWorkspace(
      { cwd: target.cwd },
      (nextSnapshot) => this.rememberWorkspaceSnapshot(target, nextSnapshot),
    );
    if (!this.isActiveTarget(target)) {
      workspaceSubscription.unsubscribe();
      return;
    }
    target.workspaceGitUnsubscribe = workspaceSubscription.unsubscribe;
    const workingTree =
      target.compare.mode === "base"
        ? Promise.resolve()
        : this.workspaceGitService
            .requestWorkingTreeWatch(target.cwd, () => this.scheduleTargetRefresh(target))
            .then(({ repoRoot, unsubscribe }) => {
              if (!this.isActiveTarget(target)) {
                unsubscribe();
              } else {
                target.diffCwd = repoRoot ?? target.cwd;
                target.workingTreeWatchUnsubscribe = unsubscribe;
              }
              return undefined;
            });
    await Promise.all([workspaceSubscription.ready, workingTree]);
    if (!this.isActiveTarget(target)) return;
    // A change between the initial Git snapshot and either registration must
    // not remain hidden until the next filesystem event. Background refreshes
    // stay outside the reserved explicit-read priority lane.
    if (workspaceSubscription.ready || target.compare.mode !== "base") {
      this.scheduleTargetRefresh(target);
    }
  }
}
