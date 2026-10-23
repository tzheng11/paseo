import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path, { join } from "node:path";
import type pino from "pino";
import type { ForgeService } from "../services/forge-service.js";
import type {
  CheckoutSnapshotFacts,
  CheckoutStatusGit,
  PullRequestStatusResult,
} from "../utils/checkout-git.js";
import {
  WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
  WORKSPACE_GIT_REFRESH_CONCURRENCY,
  WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS,
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "./workspace-git-service.js";

import { NativeRecursiveResources } from "./file-observer/internal/native-recursive-resources.js";

const REPO_CWD = path.resolve("/tmp/repo");

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function createSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]>;
  },
): WorkspaceGitRuntimeSnapshot {
  const base: WorkspaceGitRuntimeSnapshot = {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
    },
    forge: {
      featuresEnabled: true,
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Update feature",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
      },
      error: null,
    },
  };

  const featuresEnabled = overrides?.forge?.featuresEnabled ?? base.forge.featuresEnabled;
  const authState =
    overrides?.forge?.authState ?? (featuresEnabled ? "authenticated" : "no_remote");
  const forgeName = resolveSnapshotForgeName(featuresEnabled, overrides);
  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    forge: {
      ...base.forge,
      ...overrides?.forge,
      featuresEnabled,
      authState,
      ...(forgeName ? { forge: forgeName } : {}),
      pullRequest: resolveSnapshotPullRequest(base, overrides),
      error: resolveSnapshotError(base, overrides),
    },
  };
}

function hasForgeOverride(
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
  key: keyof WorkspaceGitRuntimeSnapshot["forge"],
): boolean {
  return Boolean(overrides?.forge && key in overrides.forge);
}

function resolveSnapshotForgeName(
  featuresEnabled: boolean,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): string | undefined {
  if (hasForgeOverride(overrides, "forge")) {
    return overrides?.forge?.forge;
  }
  return featuresEnabled ? "github" : undefined;
}

function resolveSnapshotPullRequest(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"] {
  if (hasForgeOverride(overrides, "pullRequest")) {
    return overrides?.forge?.pullRequest ?? null;
  }
  return base.forge.pullRequest;
}

function resolveSnapshotError(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["error"] {
  if (hasForgeOverride(overrides, "error")) {
    return overrides?.forge?.error ?? null;
  }
  return base.forge.error;
}

function createCheckoutStatus(
  cwd: string,
  overrides?: Partial<CheckoutStatusGit>,
): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "https://github.com/acme/repo.git",
    isPaseoOwnedWorktree: false,
    ...overrides,
  };
}

function createCheckoutSnapshotFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: "https://github.com/acme/repo.git",
    absoluteGitDir: join(cwd, ".git"),
    gitCommonDir: join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: "origin",
    branchMergeRef: "refs/heads/main",
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createPullRequestStatusResult(
  overrides?: Partial<PullRequestStatusResult>,
): PullRequestStatusResult {
  return {
    status: {
      url: "https://github.com/acme/repo/pull/123",
      title: "Update feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
    },
    authState: "authenticated",
    featuresEnabled: true,
    githubFeaturesEnabled: true,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAsyncSubscription() {
  return {
    updateIgnore: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(() => Promise.resolve()),
  };
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    searchIssuesAndPrs: vi.fn(async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    })),
    getPullRequest: vi.fn(async () => ({
      number: 1,
      title: "PR",
      url: "https://github.com/acme/repo/pull/1",
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: "feature",
      labels: [],
    })),
    getPullRequestHeadRef: vi.fn(async () => "feature"),
    getPullRequestCheckoutTarget: vi.fn(async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: "feature",
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    })),
    getCurrentPullRequestStatus: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({
      url: "https://github.com/acme/repo/pull/1",
      number: 1,
    })),
    mergePullRequest: vi.fn(async () => ({ success: true })),
    isAuthenticated: vi.fn(async () => true),
    authProbeCanThrow: true,
    invalidate: vi.fn(),
  };
}

interface CreateServiceTestOptions {
  getCheckoutDiff?: ReturnType<typeof vi.fn>;
  subscribe?: ReturnType<typeof vi.fn>;
  getCheckoutStatus?: ReturnType<typeof vi.fn>;
  getCheckoutSnapshotFacts?: ReturnType<typeof vi.fn>;
  getCheckoutShortstat?: ReturnType<typeof vi.fn>;
  getCheckoutWorktreeState?: ReturnType<typeof vi.fn>;
  getPullRequestStatus?: ReturnType<typeof vi.fn>;
  github?: ForgeService;
  resolveAbsoluteGitDir?: ReturnType<typeof vi.fn>;
  hasOriginRemote?: ReturnType<typeof vi.fn>;
  runGitFetch?: ReturnType<typeof vi.fn>;
  runGitCommand?: ReturnType<typeof vi.fn>;
  getWorkspaceGitSelfHealPhaseMs?: (cwd: string) => number;
  now?: () => Date;
}

function buildDefaultTestServiceDeps() {
  return {
    subscribe: vi.fn(async () => ({
      updateIgnore: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
    })),
    getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd)),
    getCheckoutRefDerivedState: vi.fn(async (_cwd, facts, current) => ({
      ...current,
      upstreamStatus: facts.upstreamStatus,
    })),
    getCheckoutStatus: vi.fn(async (cwd: string) => createCheckoutStatus(cwd)),
    getCheckoutShortstat: vi.fn(async () => ({
      additions: 1,
      deletions: 0,
    })),
    getCheckoutWorktreeState: vi.fn(),
    getPullRequestStatus: vi.fn(async () => createPullRequestStatusResult()),
    forgeOverrides: { github: createGitHubServiceStub() },
    resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
    hasOriginRemote: vi.fn(async () => false),
    runGitFetch: vi.fn(async () => ({ changes: [], error: null })),
    runGitCommand: vi.fn(async () => ({
      stdout: `${REPO_CWD}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    })),
    getWorkspaceGitSelfHealPhaseMs: vi.fn(() => 30_000),
    createWatcherLivenessCanary: vi.fn(() => ({
      path: "",
      filterEvents: (events) => events,
      verify: vi.fn(async () => {}),
    })),
    now: () => new Date("2026-04-12T00:00:00.000Z"),
  };
}

function createService(options?: CreateServiceTestOptions) {
  const deps = { ...buildDefaultTestServiceDeps(), ...options };
  deps.getCheckoutWorktreeState =
    options?.getCheckoutWorktreeState ??
    vi.fn(async (cwd: string) => {
      const status = await deps.getCheckoutStatus(cwd);
      if (!status.isGit) {
        throw new Error("Expected a git checkout");
      }
      return {
        isDirty: status.isDirty,
        diffStat: await deps.getCheckoutShortstat(),
      };
    });
  return new WorkspaceGitServiceImpl({
    logger: createLogger() as unknown as pino.Logger,
    paseoHome: "/tmp/paseo-test",
    deps,
  });
}

describe("WorkspaceGitServiceImpl", () => {
  test("an explicit diff does not wait for queued recursive or metadata observation", async () => {
    const watch = createDeferred<ReturnType<typeof createAsyncSubscription>>();
    const getCheckoutDiff = vi.fn(async () => ({ diff: "fresh" }));
    const service = createService({ subscribe: vi.fn(() => watch.promise), getCheckoutDiff });
    const owner = service.registerWorkspace({ cwd: REPO_CWD }, () => {});
    let result: unknown;
    const reading = service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" }).then((value) => {
      result = value;
      return value;
    });
    try {
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
      expect(result).toEqual({ diff: "fresh" });
      expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
    } finally {
      owner.unsubscribe();
      watch.resolve(createAsyncSubscription());
      await reading;
      await service.dispose();
    }
  });

  test("registration readiness includes metadata setup after the recursive watcher opens", async () => {
    const recursive = createDeferred<ReturnType<typeof createAsyncSubscription>>();
    const metadata = createDeferred<ReturnType<typeof createAsyncSubscription>>();
    const subscribe = vi.fn((cwd: string) =>
      cwd === REPO_CWD ? recursive.promise : metadata.promise,
    );
    const service = createService({ subscribe });
    const owner = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    let ready = false;
    const opening = owner.ready?.then(() => {
      ready = true;
      return ready;
    });
    try {
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
      expect(ready).toBe(false);
      recursive.resolve(createAsyncSubscription());
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
      expect(subscribe.mock.calls.map(([cwd]) => cwd)).toEqual([REPO_CWD, join(REPO_CWD, ".git")]);
      expect(ready).toBe(false);
      metadata.resolve(createAsyncSubscription());
      await opening;
      expect(ready).toBe(true);
    } finally {
      recursive.resolve(createAsyncSubscription());
      metadata.resolve(createAsyncSubscription());
      owner.unsubscribe();
      await opening;
      await service.dispose();
    }
  });

  test("cold snapshots keep progressing while warm refresh generations are held", async () => {
    const warm = Array.from({ length: 3 }, (_, i) => path.resolve(`/tmp/held-warm-${i}`));
    const cold = Array.from({ length: 92 }, (_, i) => path.resolve(`/tmp/progress-cold-${i}`));
    const callbacks = new Map<
      string,
      (error: Error | null, events: Array<{ path: string; type: "update" }>) => void
    >();
    const warmGate = createDeferred<{ isDirty: boolean; diffStat: null }>();
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const getCheckoutWorktreeState = vi.fn(() => warmGate.promise);
    const subscribe = vi.fn(async (cwd, callback) => {
      callbacks.set(cwd, callback);
      return createAsyncSubscription();
    });
    const runGitCommand = vi.fn(async (_args: string[], options: { cwd: string }) => ({
      stdout: `${options.cwd}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService({
      subscribe,
      getCheckoutStatus,
      getCheckoutWorktreeState,
      runGitCommand,
    });
    const subscriptions = warm.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    await vi.waitFor(() => {
      for (const cwd of warm) expect(service.peekSnapshot(cwd)?.git.isGit).toBe(true);
    });
    await vi.waitFor(() =>
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0),
    );
    for (const cwd of warm)
      callbacks.get(cwd)!(null, [{ path: join(cwd, "tracked.ts"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(getCheckoutWorktreeState).toHaveBeenCalled());
    subscriptions.push(...cold.map((cwd) => service.registerWorkspace({ cwd }, vi.fn())));
    await vi.waitFor(() => {
      for (const cwd of cold) expect(service.peekSnapshot(cwd)?.git.isGit).toBe(true);
    });
    expect(service.getMetrics().workspaceInitialRefreshPendingCount).toBe(0);
    warmGate.resolve({ isDirty: true, diffStat: null });
    for (const subscription of subscriptions) subscription.unsubscribe();
    service.dispose();
  });

  test("checkout membership reads use Git facts without reading dirty worktree status", async () => {
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd));
    const getCheckoutStatus = vi.fn(async () => {
      throw new Error("status scan must not run");
    });
    const service = createService({ getCheckoutSnapshotFacts, getCheckoutStatus });
    await expect(service.getCheckout(REPO_CWD)).resolves.toMatchObject({
      cwd: REPO_CWD,
      isGit: true,
      currentBranch: "main",
      worktreeRoot: REPO_CWD,
    });
    expect(getCheckoutStatus).not.toHaveBeenCalled();
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  test.each([
    {
      name: "main checkout",
      mainRepoRoot: REPO_CWD,
      owned: false,
      base: "main",
      expectedMain: null,
      expectedOwned: false,
    },
    {
      name: "native linked checkout",
      mainRepoRoot: path.resolve("/tmp/main-root"),
      owned: false,
      base: "main",
      expectedMain: path.resolve("/tmp/main-root"),
      expectedOwned: false,
    },
    {
      name: "owned checkout with base",
      mainRepoRoot: null,
      owned: true,
      base: "main",
      expectedMain: REPO_CWD,
      expectedOwned: true,
    },
    {
      name: "owned checkout without base",
      mainRepoRoot: REPO_CWD,
      owned: true,
      base: null,
      expectedMain: null,
      expectedOwned: false,
    },
  ])(
    "checkout identity preserves the status projection for $name",
    async ({ mainRepoRoot, owned, base, expectedMain, expectedOwned }) => {
      const facts = {
        ...createCheckoutSnapshotFacts(REPO_CWD),
        mainRepoRoot,
        paseoWorktree: { isPaseoOwnedWorktree: owned },
        resolvedBaseRef: base,
      };
      const service = createService({ getCheckoutSnapshotFacts: vi.fn(async () => facts) });
      await expect(service.getCheckout(REPO_CWD)).resolves.toMatchObject({
        mainRepoRoot: expectedMain,
        isPaseoOwnedWorktree: expectedOwned,
      });
      service.dispose();
    },
  );

  test("bulk checkout membership reads stay bounded and share a pending read for the same checkout", async () => {
    const gate = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => {
      await gate.promise;
      return createCheckoutSnapshotFacts(cwd);
    });
    const service = createService({ getCheckoutSnapshotFacts });
    const roots = Array.from({ length: 92 }, (_, i) => path.resolve(`/tmp/membership-${i}`));
    const reads = roots.map((cwd) => service.getCheckout(cwd));
    const duplicate = service.getCheckout(roots[0]);
    await vi.waitFor(() => expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2));
    gate.resolve();
    const result = await Promise.all(reads);
    await expect(duplicate).resolves.toEqual(result[0]);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(92);
    await service.getCheckout(roots[0]);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(93);
    service.dispose();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("registerWorkspace returns a subscription without an initial snapshot contract", async () => {
    const service = createService();

    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(subscription).toEqual({ ready: expect.any(Promise), unsubscribe: expect.any(Function) });
    expect("initial" in subscription).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(service.peekSnapshot(REPO_CWD)).toBeNull();

    subscription.unsubscribe();
    service.dispose();
  });

  test("onSnapshotUpdated emits only for observed workspace snapshots and can unsubscribe", async () => {
    const service = createService();
    const snapshotListener = vi.fn();
    const snapshotSubscription = service.onSnapshotUpdated(snapshotListener);

    await service.getSnapshot(REPO_CWD, { force: true, reason: "unobserved" });

    expect(snapshotListener).not.toHaveBeenCalled();

    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await service.getSnapshot(REPO_CWD, { force: true, reason: "observed" });

    expect(snapshotListener).toHaveBeenCalledTimes(1);
    expect(snapshotListener).toHaveBeenCalledWith(createSnapshot(REPO_CWD));

    snapshotSubscription.unsubscribe();
    await service.getSnapshot(REPO_CWD, { force: true, reason: "after-unsubscribe" });

    expect(snapshotListener).toHaveBeenCalledTimes(1);

    workspaceSubscription.unsubscribe();
    service.dispose();
  });

  test("getSnapshot populates github pull request state in the runtime snapshot", async () => {
    const getPullRequestStatus = vi.fn(async () =>
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/999",
          title: "Ship runtime centralization",
          state: "open",
          baseRefName: "main",
          headRefName: "workspace-git-service",
          isMerged: false,
        },
      }),
    );

    const service = createService({
      getPullRequestStatus,
      now: () => new Date("2026-04-12T02:03:04.000Z"),
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/999",
            title: "Ship runtime centralization",
            state: "open",
            baseRefName: "main",
            headRefName: "workspace-git-service",
            isMerged: false,
          },
        },
      }),
    );
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot does not probe isAuthenticated for a forge adapter that never throws from it", async () => {
    const gitlabIsAuthenticated = vi.fn(async () => false);
    const gitlabStub: ForgeService = {
      ...createGitHubServiceStub(),
      isAuthenticated: gitlabIsAuthenticated,
      authProbeCanThrow: undefined,
    };
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());

    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, { remoteUrl: "https://gitlab.com/acme/repo.git" }),
      ),
      getPullRequestStatus,
      forgeOverrides: { gitlab: gitlabStub },
    });

    await service.getSnapshot(REPO_CWD);

    expect(gitlabIsAuthenticated).not.toHaveBeenCalled();
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot keeps plain git classification when shortstat lookup fails", async () => {
    const getCheckoutShortstat = vi.fn(async () => {
      throw new Error(
        "Missing Paseo worktree base metadata: /tmp/repo/.git/worktrees/feature/paseo/worktree.json",
      );
    });
    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          repoRoot: cwd,
          currentBranch: "feature/worktree",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
        }),
      ),
      getCheckoutShortstat,
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        git: {
          repoRoot: REPO_CWD,
          currentBranch: "feature/worktree",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
          diffStat: null,
        },
      }),
    );
  });

  test("non-forced workspace refresh does not reload GitHub or emit when state is unchanged", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });
    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    nowMs += 3_000;
    await service.refresh(REPO_CWD);

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("cold getSnapshot calls share one workspace target setup and cache the snapshot", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
    });

    const firstSnapshotPromise = service.getSnapshot(REPO_CWD);
    const secondSnapshotPromise = service.getSnapshot(join(REPO_CWD, "."));
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    });
    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    checkoutStatusDeferred.resolve(createCheckoutStatus(REPO_CWD));

    await expect(Promise.all([firstSnapshotPromise, secondSnapshotPromise])).resolves.toEqual([
      createSnapshot(REPO_CWD),
      createSnapshot(REPO_CWD),
    ]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(service.peekSnapshot(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(createSnapshot(REPO_CWD));
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("bounds refresh generations and re-enqueues hot workspace successors fairly", async () => {
    const hotCwds = Array.from({ length: WORKSPACE_GIT_REFRESH_CONCURRENCY }, (_, index) =>
      path.resolve(`/tmp/hot-repo-${index}`),
    );
    const fifthCwd = path.resolve("/tmp/fifth-repo");
    const firstReadGates = new Map(
      [...hotCwds, fifthCwd].map((cwd) => [cwd, createDeferred<CheckoutStatusGit>()]),
    );
    const pendingFirstReads = new Set(firstReadGates.keys());
    const startedReads: string[] = [];
    const getCheckoutStatus = vi.fn((cwd: string) => {
      startedReads.push(cwd);
      const firstRead = firstReadGates.get(cwd);
      if (firstRead && pendingFirstReads.delete(cwd)) {
        return firstRead.promise;
      }
      return Promise.resolve(createCheckoutStatus(cwd, { currentBranch: "successor" }));
    });
    const service = createService({ getCheckoutStatus });

    const hotInitialReads = hotCwds.map((cwd) => service.getSnapshot(cwd, { includeForge: false }));
    await vi.waitFor(() => {
      expect(startedReads).toEqual(hotCwds);
    });

    const fifthRead = service.getSnapshot(fifthCwd, { includeForge: false });
    const hotSuccessorReads = hotCwds.map((cwd) =>
      service.getSnapshot(cwd, {
        force: true,
        includeForge: false,
        reason: "hot-successor",
      }),
    );
    expect(service.getMetrics()).toMatchObject({
      workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceRefreshAdmissionPendingCount: 1,
      workspaceRefreshQueuedCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
    });

    firstReadGates.get(hotCwds[0])?.resolve(createCheckoutStatus(hotCwds[0]));
    await vi.waitFor(() => {
      expect(startedReads).toContain(fifthCwd);
    });
    expect(startedReads.filter((cwd) => cwd === hotCwds[0])).toHaveLength(1);

    for (const [cwd, gate] of firstReadGates) {
      gate.resolve(createCheckoutStatus(cwd));
    }
    await Promise.all([...hotInitialReads, fifthRead, ...hotSuccessorReads]);

    for (const cwd of hotCwds) {
      expect(startedReads.filter((startedCwd) => startedCwd === cwd)).toHaveLength(2);
    }
    expect(startedReads.filter((cwd) => cwd === fifthCwd)).toHaveLength(1);

    service.dispose();
  });

  test("staggered cold inventory lets an explicit read bypass all queued workspaces", async () => {
    const cwds = Array.from({ length: 83 }, (_, index) => path.resolve(`/tmp/cold-repo-${index}`));
    const firstRead = createDeferred<CheckoutStatusGit>();
    const startedReads: string[] = [];
    const getCheckoutStatus = vi.fn(async (cwd: string) => {
      startedReads.push(cwd);
      return cwd === cwds[0] ? firstRead.promise : createCheckoutStatus(cwd);
    });
    const service = createService({ getCheckoutStatus });
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    await vi.waitFor(() => expect(startedReads).toEqual([cwds[0]]));
    expect(service.getMetrics()).toMatchObject({
      workspaceInitialRefreshActiveCount: 1,
      workspaceInitialRefreshPendingCount: cwds.length - 1,
    });

    const liveCwd = cwds.at(-1)!;
    await expect(service.getSnapshot(liveCwd)).resolves.toMatchObject({ cwd: liveCwd });
    expect(startedReads).toEqual([cwds[0], liveCwd]);
    expect(service.getMetrics().workspaceRefreshAdmissionPendingCount).toBe(0);

    firstRead.resolve(createCheckoutStatus(cwds[0]!));
    await vi.waitFor(() => expect(service.peekSnapshot(cwds.at(-2)!)).not.toBeNull());
    expect(startedReads).toHaveLength(cwds.length);
    expect(new Set(startedReads).size).toBe(cwds.length);
    for (const subscription of subscriptions) subscription.unsubscribe();
    await service.dispose();
  });

  test.each(["authentication", "pull-request"])(
    "92 initial snapshots finish while forge %s is blocked",
    async (phase) => {
      const cwds = Array.from({ length: 92 }, (_, i) => path.resolve(`/tmp/forge-startup-${i}`));
      const gate = createDeferred<void>();
      const entered = vi.fn();
      const github = createGitHubServiceStub();
      github.isAuthenticated = vi.fn(async () => {
        if (phase === "authentication") {
          entered();
          await gate.promise;
        }
        return true;
      });
      const getPullRequestStatus = vi.fn(async () => {
        if (phase === "pull-request") {
          entered();
          await gate.promise;
        }
        return createPullRequestStatusResult();
      });
      const service = new WorkspaceGitServiceImpl({
        logger: createLogger() as unknown as pino.Logger,
        paseoHome: "/tmp/paseo-test",
        deps: {
          ...buildDefaultTestServiceDeps(),
          forgeOverrides: { github },
          getPullRequestStatus,
        },
      });
      const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
      try {
        await vi.waitFor(() => expect(entered).toHaveBeenCalled());
        await vi.waitFor(() => {
          expect(service.getMetrics()).toMatchObject({
            workspaceInitialRefreshActiveCount: 0,
            workspaceInitialRefreshPendingCount: 0,
          });
          for (const cwd of cwds) expect(service.peekSnapshot(cwd)?.git.isGit).toBe(true);
        });
        const snapshot = await service.getSnapshot(cwds.at(-1)!, { includeForge: false });
        expect(snapshot.git.currentBranch).toBe("main");
        gate.resolve();
        await vi.waitFor(() =>
          expect(service.peekSnapshot(cwds.at(-1)!)?.forge.pullRequest?.url).toBe(
            "https://github.com/acme/repo/pull/123",
          ),
        );
      } finally {
        gate.resolve();
        for (const subscription of subscriptions) subscription.unsubscribe();
        await service.dispose();
      }
    },
  );

  test("Git updates finish while initial forge enrichment is still pending", async () => {
    const gate = createDeferred<PullRequestStatusResult>();
    const getPullRequestStatus = vi.fn(() => gate.promise);
    let dirty = false;
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { isDirty: dirty }),
    );
    const service = createService({ getCheckoutStatus, getPullRequestStatus });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    try {
      await vi.waitFor(() => expect(getPullRequestStatus).toHaveBeenCalled());
      expect(service.peekSnapshot(REPO_CWD)?.git.isDirty).toBe(false);
      dirty = true;
      const refresh = service.getSnapshot(REPO_CWD, {
        force: true,
        includeForge: false,
        reason: "edit-during-initial-forge",
      });
      await vi.waitFor(() => expect(getCheckoutStatus).toHaveBeenCalledTimes(2));
      await expect(refresh).resolves.toMatchObject({ git: { isDirty: true } });
    } finally {
      gate.resolve(createPullRequestStatusResult());
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("late initial PR lookup cannot publish over a changed branch", async () => {
    const gate = createDeferred<PullRequestStatusResult>();
    const getPullRequestStatus = vi.fn(() => gate.promise);
    let branch = "main";
    const service = createService({
      getPullRequestStatus,
      getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => ({
        ...createCheckoutSnapshotFacts(cwd),
        currentBranch: branch,
        pullRequestLookupTarget: { headRef: branch },
      })),
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, { currentBranch: branch }),
      ),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    try {
      await vi.waitFor(() => expect(getPullRequestStatus).toHaveBeenCalled());
      branch = "feature";
      await service.getSnapshot(REPO_CWD, {
        force: true,
        includeForge: false,
        reason: "branch-change-during-initial-forge",
      });
      gate.resolve(createPullRequestStatusResult());
      await vi.waitFor(() =>
        expect(service.getMetrics().workspaceForgeRefreshAdmissionActiveCount).toBe(0),
      );
      expect(service.peekSnapshot(REPO_CWD)).toMatchObject({
        git: { currentBranch: "feature" },
        forge: { pullRequest: null },
      });
    } finally {
      gate.resolve(createPullRequestStatusResult());
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("a hot workspace successor cannot hold cold discovery and watcher registration", async () => {
    const hot = path.resolve("/tmp/hot-startup");
    const cold = path.resolve("/tmp/cold-startup");
    const initial = createDeferred<CheckoutStatusGit>();
    const successor = createDeferred<CheckoutStatusGit>();
    const started: string[] = [];
    let hotReads = 0;
    const subscribe = vi.fn(async () => createAsyncSubscription());
    const service = createService({
      subscribe,
      runGitCommand: vi.fn(async (_args, options) => ({
        stdout: `${options.cwd}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      })),
      getCheckoutStatus: vi.fn(async (cwd: string) => {
        started.push(cwd);
        if (cwd !== hot) return createCheckoutStatus(cwd);
        hotReads += 1;
        return hotReads === 1 ? initial.promise : successor.promise;
      }),
    });
    const subscriptions = [hot, cold].map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    let followup: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(started).toEqual([hot]));
      followup = service.getSnapshot(hot, {
        force: true,
        includeForge: false,
        reason: "startup-successor",
      });
      initial.resolve(createCheckoutStatus(hot));
      await vi.waitFor(() => expect(started).toContain(cold));
      await vi.waitFor(() => expect(service.peekSnapshot(cold)).not.toBeNull());
      await vi.waitFor(() =>
        expect(subscribe).toHaveBeenCalledWith(cold, expect.any(Function), expect.any(Object)),
      );
      expect(service.getMetrics().workspaceInitialRefreshPendingCount).toBe(0);
      expect(started.filter((cwd) => cwd === hot)).toHaveLength(2);
    } finally {
      initial.resolve(createCheckoutStatus(hot));
      successor.resolve(createCheckoutStatus(hot));
      await followup;
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("95 linked workspaces register observation while the first cold snapshot is blocked", async () => {
    const cwds = Array.from({ length: 95 }, (_, i) => path.resolve(`/tmp/linked-startup-${i}`));
    const gate = createDeferred<void>();
    const subscribe = vi.fn(async () => createAsyncSubscription());
    const service = createService({
      subscribe,
      getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => ({
        ...createCheckoutSnapshotFacts(cwd),
        gitCommonDir: path.resolve("/tmp/linked-common/.git"),
      })),
      getCheckoutStatus: vi.fn(async (cwd: string) => {
        await gate.promise;
        return createCheckoutStatus(cwd);
      }),
      runGitCommand: vi.fn(async (_args, options) => ({
        stdout: `${options.cwd}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      })),
    });
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    try {
      await vi.waitFor(() => {
        const observed = new Set<string>();
        for (const [directory] of subscribe.mock.calls) observed.add(directory);
        for (const cwd of cwds) expect(observed.has(cwd)).toBe(true);
      });
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 1,
        repositoryWorkspaceLinkCount: 95,
        workspaceRefreshAdmissionActiveCount: 1,
        workspaceInitialRefreshPendingCount: 94,
      });
    } finally {
      gate.resolve();
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("delayed cold snapshots reload facts discovered before a branch change", async () => {
    const hot = path.resolve("/tmp/blocked-initial-facts");
    const cold = path.resolve("/tmp/delayed-initial-facts");
    const gate = createDeferred<void>();
    let nowMs = 0;
    const facts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      currentBranch: nowMs === 0 ? "before" : "after",
    }));
    const service = createService({
      now: () => new Date(nowMs),
      getCheckoutSnapshotFacts: facts,
      getCheckoutStatus: vi.fn(async (cwd: string, context: { facts?: CheckoutSnapshotFacts }) => {
        if (cwd === hot) await gate.promise;
        return createCheckoutStatus(cwd, {
          currentBranch: context.facts?.isGit ? context.facts.currentBranch : null,
        });
      }),
    });
    const subscriptions = [hot, cold].map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    try {
      await vi.waitFor(() => expect(facts).toHaveBeenCalledWith(cold, expect.any(Object)));
      nowMs = 10_000;
      gate.resolve();
      await vi.waitFor(() => expect(service.peekSnapshot(cold)?.git.currentBranch).toBe("after"));
    } finally {
      gate.resolve();
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("cold metadata and polling refreshes cannot bypass initial admission", async () => {
    const cwds = Array.from({ length: 12 }, (_, i) => path.resolve(`/tmp/cold-trigger-${i}`));
    const gate = createDeferred<void>();
    const started: string[] = [];
    const live = cwds.at(-1)!;
    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) => {
        started.push(cwd);
        if (cwd !== live) await gate.promise;
        return createCheckoutStatus(cwd);
      }),
    });
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    let read: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(started).toEqual([cwds[0]]));
      for (const cwd of cwds.slice(0, -1)) service.onWorkspaceStateMayHaveChanged(cwd);
      await vi.advanceTimersByTimeAsync(1_000);
      let snapshot: WorkspaceGitRuntimeSnapshot | undefined;
      read = service.getSnapshot(live).then((value) => {
        snapshot = value;
        return value;
      });
      await flushPromises();
      await flushPromises();
      expect(started).toEqual([cwds[0], live]);
      gate.resolve();
      await read;
      expect(snapshot?.cwd).toBe(live);
      const startsForFirst = () => started.filter((cwd) => cwd === cwds[0]);
      await vi.waitFor(() => expect(startsForFirst()).toHaveLength(2));
    } finally {
      gate.resolve();
      await read?.catch(() => undefined);
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("warm background refreshes reserve admission for a cold live read", async () => {
    const cwds = Array.from({ length: 8 }, (_, i) => path.resolve(`/tmp/warm-trigger-${i}`));
    const live = path.resolve("/tmp/cold-live");
    const gate = createDeferred<void>();
    let block = false;
    const started: string[] = [];
    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) => {
        if (block) {
          started.push(cwd);
          if (cwd !== live) await gate.promise;
        }
        return createCheckoutStatus(cwd);
      }),
    });
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    let read: Promise<unknown> | undefined;
    try {
      await Promise.all(cwds.map((cwd) => service.getSnapshot(cwd)));
      block = true;
      for (const cwd of cwds) service.onWorkspaceStateMayHaveChanged(cwd);
      await vi.advanceTimersByTimeAsync(1_000);
      read = service.getSnapshot(live);
      await flushPromises();
      await flushPromises();
      expect(started).toContain(live);
      expect(started.filter((cwd) => cwd !== live)).toHaveLength(
        WORKSPACE_GIT_REFRESH_CONCURRENCY - 2,
      );
      gate.resolve();
      await read;
    } finally {
      gate.resolve();
      await read?.catch(() => undefined);
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("all-polling refreshes leave admission for an uncached live read", async () => {
    const cwds = Array.from({ length: 86 }, (_, i) => path.resolve(`/tmp/all-polling-${i}`));
    const live = path.resolve("/tmp/all-polling-live");
    const gate = createDeferred<void>();
    const blocked = new Set<string>();
    let hold = false;
    const service = createService({
      subscribe: vi.fn(async () => {
        throw Object.assign(new Error("watcher admission EMFILE"), { code: "EMFILE" });
      }),
      runGitCommand: vi.fn(async (_args: string[], options: { cwd: string }) => ({
        stdout: `${options.cwd}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      })),
      getCheckoutStatus: vi.fn(async (cwd: string) => {
        if (hold && cwd !== live) {
          blocked.add(cwd);
          await gate.promise;
        }
        return createCheckoutStatus(cwd);
      }),
    });
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    let read: Promise<WorkspaceGitRuntimeSnapshot> | undefined;
    try {
      await Promise.all(cwds.map((cwd) => service.getSnapshot(cwd)));
      await vi.waitFor(() =>
        expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0),
      );
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(cwds.length);
      hold = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(blocked.size).toBe(WORKSPACE_GIT_REFRESH_CONCURRENCY - 2));
      expect(service.peekSnapshot(live)).toBeNull();
      read = service.getSnapshot(live, { force: true, reason: "all-polling-live-read" });
      await expect(read).resolves.toMatchObject({ cwd: live });
      expect(blocked.size).toBe(WORKSPACE_GIT_REFRESH_CONCURRENCY - 2);
      gate.resolve();
      await vi.waitFor(() => expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0));
    } finally {
      hold = false;
      gate.resolve();
      await read;
      for (const subscription of subscriptions) subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("bounds workspace observation setup pipelines", async () => {
    const cwds = Array.from(
      { length: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY + 2 },
      (_, index) => `/tmp/observation-repo-${index}`,
    );
    const setupGate = createDeferred<void>();
    let activeSetups = 0;
    let maxActiveSetups = 0;
    const subscribe = vi.fn(async () => {
      activeSetups += 1;
      maxActiveSetups = Math.max(maxActiveSetups, activeSetups);
      await setupGate.promise;
      activeSetups -= 1;
      return createAsyncSubscription();
    });
    const runGitCommand = vi.fn(async (_args: string[], options: { cwd: string }) => ({
      stdout: `${options.cwd}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService({ subscribe, runGitCommand });

    await Promise.all(cwds.map((cwd) => service.getSnapshot(cwd, { includeForge: false })));
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));

    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);
    });
    expect(maxActiveSetups).toBe(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);
    expect(service.getMetrics()).toMatchObject({
      workspaceObservationSetupAdmissionActiveCount: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
      workspaceObservationSetupAdmissionPendingCount: 2,
    });

    setupGate.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    expect(maxActiveSetups).toBe(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    service.dispose();
  });

  test.each([24_000, 128_000])(
    "inventory progress renews idle expiry but retains the absolute cap (%s ms)",
    async (durationMs) => {
      const starting = createDeferred<ReturnType<typeof createAsyncSubscription>>();
      let options: { signal?: AbortSignal; onInventoryProgress?: () => void } | undefined;
      const service = createService({
        subscribe: vi.fn(async (directory, _callback, input) => {
          if (directory === REPO_CWD) {
            options = input;
            return starting.promise;
          }
          return createAsyncSubscription();
        }),
      });
      await service.getSnapshot(REPO_CWD, { includeForge: false });
      const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
      try {
        await vi.waitFor(() => expect(options).toBeDefined());
        for (let elapsed = 0; elapsed < durationMs; elapsed += 8_000) {
          await vi.advanceTimersByTimeAsync(8_000);
          options?.onInventoryProgress?.();
        }
        expect(options?.signal?.aborted).toBe(durationMs > 120_000);
        starting.resolve(createAsyncSubscription());
        await vi.waitFor(() => expect(service.getMetrics().repositoryWorkspaceLinkCount).toBe(1));
      } finally {
        starting.resolve(createAsyncSubscription());
        subscription.unsubscribe();
        await service.dispose();
      }
    },
  );

  test("watcher subscription deadlines release observation admission slots", async () => {
    const cwds = Array.from(
      { length: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY + 2 },
      (_, index) => path.resolve(`/tmp/deadline-repo-${index}`),
    );
    const stalledSubscriptions = Array.from(
      { length: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY },
      () => createDeferred<ReturnType<typeof createAsyncSubscription>>(),
    );
    const subscribedPaths: string[] = [];
    const subscribe = vi.fn((watchPath: string) => {
      subscribedPaths.push(watchPath);
      const stalled = stalledSubscriptions.shift();
      return stalled?.promise ?? Promise.resolve(createAsyncSubscription());
    });
    const runGitCommand = vi.fn(async (_args: string[], options: { cwd: string }) => ({
      stdout: `${options.cwd}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService({ subscribe, runGitCommand });

    await Promise.all(cwds.map((cwd) => service.getSnapshot(cwd, { includeForge: false })));
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));

    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);
    });

    await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS);
    await vi.waitFor(() => {
      expect(subscribedPaths).toEqual(expect.arrayContaining(cwds));
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    service.dispose();
  });

  test("dispose settles queued refresh and observation work and cleans late watchers", async () => {
    const cwds = Array.from({ length: WORKSPACE_GIT_REFRESH_CONCURRENCY + 1 }, (_, index) =>
      path.resolve(`/tmp/dispose-repo-${index}`),
    );
    const refreshGates = new Map(cwds.map((cwd) => [cwd, createDeferred<CheckoutStatusGit>()]));
    const getCheckoutStatus = vi.fn((cwd: string) => {
      const gate = refreshGates.get(cwd);
      if (!gate) {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }
      return gate.promise;
    });
    const watcherGates = Array.from({ length: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY }, () =>
      createDeferred<ReturnType<typeof createAsyncSubscription>>(),
    );
    const lateSubscriptions = watcherGates.map(() => createAsyncSubscription());
    const lateUnsubscribes = lateSubscriptions.map(({ unsubscribe }) => unsubscribe);
    const subscribe = vi.fn(
      () => watcherGates[subscribe.mock.calls.length - 1]?.promise ?? Promise.reject(),
    );
    const runGitCommand = vi.fn(async (_args: string[], options: { cwd: string }) => ({
      stdout: `${options.cwd}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService({ getCheckoutStatus, subscribe, runGitCommand });

    // Explicit demand still fills the shared pool; cold inventory has its own
    // staggered queue and must also be harmless when disposal clears it.
    const refreshes = Promise.allSettled(cwds.map((cwd) => service.getSnapshot(cwd)));
    cwds.forEach((cwd) => service.registerWorkspace({ cwd }, vi.fn()));
    await vi.waitFor(() => {
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
        workspaceRefreshAdmissionPendingCount: 1,
        workspaceObservationSetupAdmissionActiveCount: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
        workspaceObservationSetupAdmissionPendingCount:
          cwds.length - WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
      });
      expect(subscribe).toHaveBeenCalledTimes(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);
    });
    const queuedRefreshSettlement = service.getSnapshot(cwds.at(-1)!).then(
      () => ({ status: "fulfilled" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    service.dispose();

    await expect(queuedRefreshSettlement).resolves.toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    await vi.waitFor(() => {
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshAdmissionPendingCount: 0,
        workspaceObservationSetupAdmissionActiveCount: 0,
        workspaceObservationSetupAdmissionPendingCount: 0,
      });
    });
    expect(subscribe).toHaveBeenCalledTimes(WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY);

    watcherGates.forEach((gate, index) => gate.resolve(lateSubscriptions[index]!));
    refreshGates.forEach((gate, cwd) => gate.resolve(createCheckoutStatus(cwd)));
    await vi.waitFor(() => {
      for (const unsubscribe of lateUnsubscribes) {
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      }
      expect(service.getMetrics().workspaceRefreshAdmissionActiveCount).toBe(0);
    });
    await refreshes;
  });

  test("cleans a watcher subscription that resolves after its deadline", async () => {
    const lateWatcher = createDeferred<ReturnType<typeof createAsyncSubscription>>();
    const lateSubscription = createAsyncSubscription();
    const subscribe = vi
      .fn()
      .mockImplementationOnce(() => lateWatcher.promise)
      .mockResolvedValue(createAsyncSubscription());
    const service = createService({ subscribe });

    await service.getSnapshot(REPO_CWD, { includeForge: false });
    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    lateWatcher.resolve(lateSubscription);

    await vi.waitFor(() => {
      expect(lateSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    });
    workspaceSubscription.unsubscribe();
    service.dispose();
    expect(lateSubscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("rejects new work after disposal", async () => {
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd));
    const runGitCommand = vi.fn();
    const service = createService({ getCheckoutSnapshotFacts, runGitCommand });

    service.dispose();

    expect(() => service.registerWorkspace({ cwd: REPO_CWD }, vi.fn())).toThrow(
      "WorkspaceGitService is disposed",
    );
    await expect(service.getSnapshot(REPO_CWD)).rejects.toThrow("WorkspaceGitService is disposed");
    await expect(service.refresh(REPO_CWD)).rejects.toThrow("WorkspaceGitService is disposed");
    await expect(service.requestWorkingTreeWatch(REPO_CWD, vi.fn())).rejects.toThrow(
      "WorkspaceGitService is disposed",
    );
    expect(() => service.scheduleRefreshForCwd(REPO_CWD)).toThrow(
      "WorkspaceGitService is disposed",
    );
    expect(() => service.onWorkspaceStateMayHaveChanged(REPO_CWD)).toThrow(
      "WorkspaceGitService is disposed",
    );
    expect(() => service.invalidateForge(REPO_CWD)).toThrow("WorkspaceGitService is disposed");
    expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  test("multiple listeners on the same workspace share one observation setup", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutSnapshotFacts,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("equivalent cwd strings share one workspace target across service entry points", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const subscription = service.registerWorkspace({ cwd: join(REPO_CWD, ".") }, vi.fn());

    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );
    expect(service.peekSnapshot(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repo-level fetch intervals are shared for workspaces in the same repo", async () => {
    const firstFetch = createDeferred<void>();
    const runGitFetch = vi.fn(async () => {
      await firstFetch.promise;
      return {
        changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
        error: null,
      };
    });
    const hasOriginRemote = vi.fn(async () => true);
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const getCheckoutRefDerivedState = vi.fn(async (_cwd, facts, current) => ({
      ...current,
      upstreamStatus: facts.upstreamStatus,
    }));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      resolveAbsoluteGitDir,
      hasOriginRemote,
      runGitFetch,
    });

    await Promise.all([
      service.getSnapshot(REPO_CWD),
      service.getSnapshot(join(REPO_CWD, "packages", "server")),
    ]);
    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace(
      { cwd: join(REPO_CWD, "packages", "server") },
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(hasOriginRemote).toHaveBeenCalledTimes(0);
    expect(runGitFetch).toHaveBeenCalledTimes(1);

    firstFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(2);
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    expect(runGitFetch).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("remote ref name drift outside the fetch interval takes the structural fallback", async () => {
    const runGitFetch = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [],
        nonRemoteRefsChanged: false,
        remoteRefs: new Set(["origin/main"]),
        error: null,
      })
      .mockResolvedValueOnce({
        changes: [],
        nonRemoteRefsChanged: false,
        remoteRefs: new Set(["origin/main", "origin/new"]),
        error: null,
      });
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const service = createService({
      getCheckoutSnapshotFacts,
      resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch,
    });
    await Promise.all([
      service.getSnapshot(REPO_CWD),
      service.getSnapshot(join(REPO_CWD, "packages", "server")),
    ]);
    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace(
      { cwd: join(REPO_CWD, "packages", "server") },
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(runGitFetch).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });
    getCheckoutSnapshotFacts.mockClear();

    await vi.advanceTimersByTimeAsync(180_000);
    await vi.waitFor(() => {
      expect(runGitFetch).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test.each([
    {
      name: "an added remote ref",
      result: {
        changes: [{ kind: "added" as const, ref: "origin/new", afterOid: "b" }],
        error: null,
      },
    },
    {
      name: "a deleted remote ref",
      result: {
        changes: [{ kind: "deleted" as const, ref: "origin/main", beforeOid: "a" }],
        error: null,
      },
    },
    {
      name: "a concurrent local ref change",
      result: { changes: [], nonRemoteRefsChanged: true, error: null },
    },
  ])("$name takes the repository-wide structural fallback", async ({ result }) => {
    const releaseFetch = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const getCheckoutRefDerivedState = vi.fn();
    const service = createService({
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async () => {
        await releaseFetch.promise;
        return result;
      }),
    });
    await Promise.all([
      service.getSnapshot(REPO_CWD),
      service.getSnapshot(join(REPO_CWD, "packages", "server")),
    ]);
    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace(
      { cwd: join(REPO_CWD, "packages", "server") },
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    releaseFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(4);
    });
    expect(getCheckoutRefDerivedState).not.toHaveBeenCalled();

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("a failed narrow remote-ref refresh falls back for that workspace", async () => {
    const releaseFetch = createDeferred<void>();
    const getCheckoutShortstat = vi
      .fn()
      .mockResolvedValueOnce({ additions: 1, deletions: 0 })
      .mockResolvedValue({ additions: 2, deletions: 0 });
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const getCheckoutRefDerivedState = vi.fn(async () => {
      throw new Error("ref moved again");
    });
    const service = createService({
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      getCheckoutShortstat,
      resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async () => {
        await releaseFetch.promise;
        return {
          changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
          error: null,
        };
      }),
    });
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    releaseFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(1);
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
      expect(getCheckoutShortstat).toHaveBeenCalledTimes(2);
    });
    expect(listener.mock.lastCall?.[0].git.diffStat).toEqual({ additions: 2, deletions: 0 });

    subscription.unsubscribe();
    service.dispose();
  });

  test("explicit forced snapshot refresh recomputes github state and notifies listeners", async () => {
    const getPullRequestStatus = vi
      .fn<() => Promise<PullRequestStatusResult>>()
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "Before refresh",
            state: "open",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        }),
      );

    const nowValues = [new Date("2026-04-12T00:00:00.000Z"), new Date("2026-04-12T00:05:00.000Z")];
    const service = createService({
      getPullRequestStatus,
      now: () => nowValues.shift() ?? new Date("2026-04-12T00:05:00.000Z"),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.forge.pullRequest?.title).toBe("Before refresh");

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-github-refresh",
    });
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("unchanged runtime snapshots do not emit duplicate updates", async () => {
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD, { remoteUrl: null }))
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      )
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      );
    const getPullRequestStatus = vi.fn<() => Promise<PullRequestStatusResult>>().mockResolvedValue(
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/123",
          title: "Runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "feature/runtime-payloads",
          isMerged: false,
        },
      }),
    );

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.git.currentBranch).toBe("main");

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        },
        forge: {
          featuresEnabled: false,
          pullRequest: null,
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("forced snapshot refresh emits even when the fingerprint matches", async () => {
    const getCheckoutStatus = vi.fn(async () => createCheckoutStatus(REPO_CWD));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-emit",
    });
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(createSnapshot(REPO_CWD));

    subscription.unsubscribe();
    service.dispose();
  });

  test("watches nested repository changes through one recursive checkout subscription", async () => {
    const unsubscribe = vi.fn(async () => {});
    const updateIgnore = vi.fn(async () => {});
    const subscribe = vi.fn(async () => ({
      updateIgnore,
      unsubscribe,
    }));
    const service = createService({ subscribe });

    const subscription = await service.requestWorkingTreeWatch(
      path.join(REPO_CWD, "packages", "server"),
      vi.fn(),
    );

    expect(subscription.repoRoot).toBe(REPO_CWD);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(REPO_CWD, expect.any(Function), {
      ignore: [join(REPO_CWD, ".git")],
      signal: expect.any(AbortSignal),
      onInventoryProgress: expect.any(Function),
    });

    subscription.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  test("requestWorkingTreeWatch reference-counts watchers by cwd", async () => {
    const unsubscribe = vi.fn(async () => {});
    const updateIgnore = vi.fn(async () => {});
    const subscribe = vi.fn(async () => ({
      updateIgnore,
      unsubscribe,
    }));
    const service = createService({ subscribe });

    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = await service.requestWorkingTreeWatch(REPO_CWD, firstListener);
    const second = await service.requestWorkingTreeWatch(join(REPO_CWD, "."), secondListener);

    expect(first.repoRoot).toBe(REPO_CWD);
    expect(second.repoRoot).toBe(REPO_CWD);
    expect(subscribe).toHaveBeenCalledTimes(1);

    first.unsubscribe();
    expect(unsubscribe).not.toHaveBeenCalled();

    second.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("capacity recovery waits for released headroom without repeating ignore inventories or delaying explicit reads", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(createAsyncSubscription());
    const runGitCommand = buildDefaultTestServiceDeps().runGitCommand;
    const service = createService({ subscribe, runGitCommand, now: () => new Date() });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    const ignoredInventoryCount = () =>
      runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files").length;
    expect(ignoredInventoryCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(ignoredInventoryCount()).toBe(1);
    await expect(
      service.getSnapshot(REPO_CWD, { force: true, reason: "capacity-explicit-read" }),
    ).resolves.toMatchObject({ git: { isGit: true } });
    existing.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(ignoredInventoryCount()).toBe(2);
    expect(service.getMetrics().workingTreeWatchSetupInFlightCount).toBe(0);
    subscription.unsubscribe();
    await service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("capacity recovery rechecks shrinking roots every five minutes and cancels after the final consumer closes", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    const subscribe = vi.fn().mockRejectedValue(failure);
    const runGitCommand = buildDefaultTestServiceDeps().runGitCommand;
    const service = createService({ subscribe, runGitCommand, now: () => new Date() });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    await vi.advanceTimersByTimeAsync(299_999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(2);
    subscription.unsubscribe();
    await service.dispose();
    existing.release();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("capacity release waits for previous unsubscribe and cannot resurrect a closed target", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    const closing = createDeferred<void>();
    const unsubscribe = vi.fn(() => closing.promise);
    const updateIgnore = vi.fn(async () => {});
    let watcherError: (error: Error, events: []) => void = () => {};
    const subscribe = vi.fn(async (_cwd, callback) => {
      watcherError = callback;
      return { updateIgnore, unsubscribe };
    });
    const service = createService({ subscribe });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    watcherError(failure, []);
    existing.release();
    await flushPromises();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await service.dispose();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("capacity admission refreshes ignore rules changed during the wait before restoring coverage", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    let ignored = true;
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "ls-files" && ignored ? "previously-ignored/\n" : `${REPO_CWD}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const callbacks: Array<
      (error: Error | null, events: Array<{ path: string; type: "update" }>) => void
    > = [];
    const subscribe = vi.fn(async (_cwd, callback) => {
      callbacks.push(callback);
      if (callbacks.length === 1) throw failure;
      return createAsyncSubscription();
    });
    const service = createService({ subscribe, runGitCommand, now: () => new Date() });
    const listener = vi.fn();
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, listener);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(1);
    ignored = false;
    existing.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls[1]?.[2]).toMatchObject({ ignore: [join(REPO_CWD, ".git")] });
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(2);
    listener.mockClear();
    callbacks[1]!(null, [
      { path: join(REPO_CWD, "previously-ignored", "tracked.ts"), type: "update" },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    await service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("failed admitted ignore validation keeps polling and retries with backoff instead of a capacity busy loop", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(createAsyncSubscription());
    const runGitCommand = buildDefaultTestServiceDeps().runGitCommand;
    const service = createService({ subscribe, runGitCommand, now: () => new Date() });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    runGitCommand.mockRejectedValueOnce(new Error("ignore inventory temporarily unavailable"));
    existing.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(3);
    subscription.unsubscribe();
    await service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("closing during admitted ignore validation prevents a late native subscription", async () => {
    const resources = new NativeRecursiveResources({
      maxTrackedEntries: 10,
      maxConcurrentAudits: 2,
    });
    const existing = resources.createInventoryReservation("existing");
    existing.setEntryCount(8);
    const failure = resources.capacityError({
      root: REPO_CWD,
      scope: "shared",
      requiredEntries: 4,
      limit: 10,
    });
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(createAsyncSubscription());
    const runGitCommand = buildDefaultTestServiceDeps().runGitCommand;
    const service = createService({ subscribe, runGitCommand, now: () => new Date() });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    const query = createDeferred<Awaited<ReturnType<typeof runGitCommand>>>();
    runGitCommand.mockImplementationOnce(() => query.promise);
    existing.release();
    await flushPromises();
    expect(runGitCommand.mock.calls.filter(([args]) => args[0] === "ls-files")).toHaveLength(2);
    subscription.unsubscribe();
    query.resolve({ stdout: "", stderr: "", truncated: false, exitCode: 0, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    await service.dispose();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("sets bounded polling and recovery when recursive observation is unavailable", async () => {
    const subscribe = vi.fn(async () => {
      throw new Error("watcher unavailable");
    });
    const service = createService({ subscribe });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    // Polling and recovery remain bounded. Ignore inventories may retain one
    // interval timer rather than immediately rerunning on recovery.
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3);

    subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    service.dispose();
  });

  test("non-git directories fall back to watching cwd with polling", async () => {
    const subscribe = vi.fn(async () => createAsyncSubscription());
    const runGitCommand = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    const resolveAbsoluteGitDir = vi.fn(async () => null);
    const service = createService({
      subscribe,
      runGitCommand,
      resolveAbsoluteGitDir,
    });

    const plainCwd = path.join(os.tmpdir(), "plain");
    const subscription = await service.requestWorkingTreeWatch(plainCwd, vi.fn());

    expect(subscription.repoRoot).toBeNull();
    expect(subscribe).toHaveBeenCalledWith(plainCwd, expect.any(Function), {
      ignore: [join(plainCwd, ".git")],
      signal: expect.any(AbortSignal),
      onInventoryProgress: expect.any(Function),
    });
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes notify watch listeners immediately", async () => {
    const watchCallbacks: Array<
      (error: Error | null, events: Array<{ path: string; type: "update" }>) => void
    > = [];
    const subscribe = vi.fn(async (_path: string, callback: (typeof watchCallbacks)[number]) => {
      watchCallbacks.push(callback);
      return createAsyncSubscription();
    });
    const service = createService({ subscribe });
    const listener = vi.fn();

    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, listener);
    expect(watchCallbacks).toHaveLength(1);

    watchCallbacks[0]?.(null, [{ path: join(REPO_CWD, "file.ts"), type: "update" }]);

    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes force a fresh diff stat for workspace subscribers", async () => {
    const watchCallbacks: Array<{
      path: string;
      callback: (error: Error | null, events: Array<{ path: string; type: "update" }>) => void;
    }> = [];
    const subscribe = vi.fn(
      async (watchPath: string, callback: (typeof watchCallbacks)[number]["callback"]) => {
        watchCallbacks.push({ path: watchPath, callback });
        return createAsyncSubscription();
      },
    );
    const getCheckoutWorktreeState = vi.fn(async () => ({
      isDirty: true,
      diffStat: { additions: 8, deletions: 3 },
    }));
    const backgroundFetch = createDeferred<void>();
    const service = createService({
      getCheckoutWorktreeState,
      runGitFetch: vi.fn(async () => {
        await backgroundFetch.promise;
        return { changes: [], error: null };
      }),
      subscribe,
    });
    const workspaceListener = vi.fn();

    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, workspaceListener);
    const diffSubscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    await vi.waitFor(() => {
      expect(service.getMetrics().repositoryWorkspaceLinkCount).toBe(1);
    });

    expect(initialSnapshot.git.diffStat).toEqual({ additions: 1, deletions: 0 });
    const repoRootWatch = watchCallbacks.find((entry) => entry.path === REPO_CWD);
    expect(repoRootWatch).toBeDefined();

    repoRootWatch?.callback(null, [{ path: join(REPO_CWD, "file.ts"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(getCheckoutWorktreeState).toHaveBeenCalledWith(
      REPO_CWD,
      expect.objectContaining({ paseoHome: "/tmp/paseo-test" }),
    );
    expect(workspaceListener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: { isDirty: true, diffStat: { additions: 8, deletions: 3 } },
      }),
    );

    diffSubscription.unsubscribe();
    workspaceSubscription.unsubscribe();
    service.dispose();
  });

  test("checkoutDiffCache evicts least-recently-used entries past its size cap", async () => {
    vi.useRealTimers();
    const getCheckoutDiff = vi.fn(async (cwd: string) => ({
      diff: `diff for ${cwd}`,
    }));
    const service = createService({
      getCheckoutDiff: getCheckoutDiff as unknown as ReturnType<typeof vi.fn>,
    });

    const CACHE_MAX = 64;
    const OVERFLOW = 5;

    for (let i = 0; i < CACHE_MAX + OVERFLOW; i++) {
      await service.getCheckoutDiff(`/tmp/repo-${i}`, { mode: "uncommitted" });
    }
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff(`/tmp/repo-${CACHE_MAX - 1}`, { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff("/tmp/repo-0", { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW + 1);

    service.dispose();
  });
});
