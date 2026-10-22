import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { createFileObserver } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { observeActiveWorkspaceGit } from "./active-workspace-git-observer.js";
import type { AgentSubscriber, ManagedAgent } from "./agent/agent-manager.js";
import type { FileChange, FileObserver, SubscribeToFileChanges } from "./file-observer/index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: null,
    absoluteGitDir: path.join(cwd, ".git"),
    gitCommonDir: path.join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: null,
    branchMergeRef: null,
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createStatus(cwd: string): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
  };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

test("initializing non-Git agents use no recursive inventory while explicit file demand and later Git initialization stay live", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-non-git-observation-")));
  writeFileSync(path.join(root, "file.txt"), "before\n");
  const observer = createFileObserver();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
    fileObserver: observer,
  });
  let emit: AgentSubscriber = () => {};
  const stop = observeActiveWorkspaceGit({
    agentManager: {
      subscribe(callback) {
        emit = callback;
        return () => {};
      },
    },
    workspaceGitService: service,
  });
  let explicit: Awaited<ReturnType<typeof service.requestWorkingTreeWatch>> | null = null;
  cleanup.push(async () => {
    explicit?.unsubscribe();
    stop();
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  emit({
    type: "agent_state",
    agent: { id: "non-git", cwd: root, lifecycle: "initializing" } as ManagedAgent,
  });
  expect((await service.getSnapshot(root, { includeForge: false })).git.isGit).toBe(false);
  await vi.waitFor(() =>
    expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0),
  );
  expect(observer.getDiagnostics()).toMatchObject({
    activeObservationCount: 0,
    nativeTrackedFileCount: 0,
  });

  const changed = vi.fn();
  explicit = await service.requestWorkingTreeWatch(root, changed);
  expect(observer.getDiagnostics().activeObservationCount).toBe(1);
  writeFileSync(path.join(root, "file.txt"), "explicit edit\n");
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 10_000 });
  explicit.unsubscribe();
  explicit = null;
  await vi.waitFor(() => expect(observer.getDiagnostics().activeObservationCount).toBe(0));

  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(path.join(root, ".gitignore"), "home/\n");
  execFileSync("git", ["add", "file.txt", ".gitignore"], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: root, stdio: "pipe" },
  );
  expect((await service.getCheckout(root)).isGit).toBe(true);
  await vi.waitFor(() => expect(observer.getDiagnostics().activeObservationCount).toBe(2), {
    timeout: 10_000,
  });
  await vi.waitFor(() =>
    expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0),
  );
  expect(service.peekSnapshot(root)?.git.isDirty).toBe(false);
  writeFileSync(path.join(root, "file.txt"), "Git edit\n");
  await vi.waitFor(() => expect(service.peekSnapshot(root)?.git.isDirty).toBe(true), {
    timeout: 10_000,
  });
}, 30_000);

test("dormant checkouts retain metadata coverage while active checkout edits remain live", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-dormant-observation-")));
  const repositories = ["first", "second", "third"].map((name) => path.join(root, name));
  for (const cwd of repositories) {
    mkdirSync(cwd);
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe" });
    writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      { cwd, stdio: "pipe" },
    );
  }
  const observer = createFileObserver();
  const liveRoots = new Set<string>();
  const fileObserver: FileObserver = {
    async subscribe(directory, callback, options) {
      const subscription = await observer.subscribe(directory, callback, options);
      const canonicalDirectory = realpathSync(directory);
      liveRoots.add(canonicalDirectory);
      return {
        updateIgnore: (paths) => subscription.updateIgnore(paths),
        async unsubscribe() {
          await subscription.unsubscribe();
          liveRoots.delete(canonicalDirectory);
        },
      };
    },
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
    fileObserver,
  });
  const summaries = repositories.map((cwd) =>
    service.registerWorkspace({ cwd, observeWorkingTree: false }, () => {}),
  );
  let active: ReturnType<typeof service.registerWorkspace> | null = null;
  cleanup.push(async () => {
    active?.unsubscribe();
    for (const summary of summaries) summary.unsubscribe();
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await Promise.all(repositories.map((cwd) => service.getSnapshot(cwd, { includeForge: false })));
  await vi.waitFor(
    () => {
      expect([...liveRoots].sort()).toEqual(
        repositories.map((cwd) => path.join(cwd, ".git")).sort(),
      );
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(0);
    },
    { timeout: 10_000 },
  );
  const hot = repositories[0]!;
  const dormantBudget = observer.getDiagnostics().nativeTrackedFileCount;
  active = service.registerWorkspace({ cwd: hot }, () => {});
  await vi.waitFor(() => expect(liveRoots.has(hot)).toBe(true), { timeout: 10_000 });
  writeFileSync(path.join(hot, "tracked.txt"), "first edit\n");
  await vi.waitFor(() => expect(service.peekSnapshot(hot)?.git.isDirty).toBe(true), {
    timeout: 10_000,
  });
  active.unsubscribe();
  active = null;
  await vi.waitFor(
    () => {
      expect(liveRoots.has(hot)).toBe(false);
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(0);
      expect(observer.getDiagnostics().nativeTrackedFileCount).toBeLessThanOrEqual(dormantBudget);
    },
    { timeout: 10_000 },
  );
  writeFileSync(path.join(hot, "tracked.txt"), "base\n");
  expect(service.peekSnapshot(hot)?.git.isDirty).toBe(true);
  expect((await service.getSnapshot(hot, { includeForge: false })).git.isDirty).toBe(false);
  active = service.registerWorkspace({ cwd: hot }, () => {});
  await vi.waitFor(() => expect(liveRoots.has(hot)).toBe(true), { timeout: 10_000 });
  writeFileSync(path.join(hot, "tracked.txt"), "second edit\n");
  await vi.waitFor(() => expect(service.peekSnapshot(hot)?.git.isDirty).toBe(true), {
    timeout: 10_000,
  });
}, 45_000);

test("a fresh checkout read makes a newly initialized repository available to cached readers", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-checkout-init-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
  });
  cleanup.push(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.isGit).toBe(false);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });

  expect((await service.getCheckout(repo)).isGit).toBe(true);
  const repoRoot = await service.resolveRepoRoot(repo);
  expect(realpathSync.native(repoRoot)).toBe(realpathSync.native(repo));
}, 30_000);

test("recursive observation updates tracked state and prunes ignored storms", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-git-observation-")));
  const repoDir = path.join(tempDir, "repo");
  const trackedPath = path.join(repoDir, "src", "tracked.txt");
  const ignoredDir = path.join(repoDir, "build");
  const remainingIgnoredDir = path.join(repoDir, "cache");
  const newlyTrackedPath = path.join(ignoredDir, "tracked.txt");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  mkdirSync(path.dirname(trackedPath), { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(remainingIgnoredDir, { recursive: true });
  writeFileSync(trackedPath, "base\n");
  writeFileSync(newlyTrackedPath, "base\n");

  let activeWatcherCount = 0;
  const observer = createFileObserver();
  let watcherStartCount = 0;
  let onWorkingTreeIgnoreUpdated: (() => void) | null = null;
  const deliveredEvents: Array<{
    directory: string;
    events: FileChange[];
  }> = [];
  const subscribe: SubscribeToFileChanges = async (directory, callback, options) => {
    const subscription = await observer.subscribe(
      directory,
      (error, events) => {
        deliveredEvents.push({ directory, events });
        callback(error, events);
      },
      options,
    );
    activeWatcherCount += 1;
    watcherStartCount += 1;
    return {
      updateIgnore: async (paths) => {
        await subscription.updateIgnore(paths);
        if (directory === repoDir) {
          const onUpdated = onWorkingTreeIgnoreUpdated;
          onWorkingTreeIgnoreUpdated = null;
          onUpdated?.();
        }
      },
      unsubscribe: async () => {
        await subscription.unsubscribe();
        activeWatcherCount -= 1;
      },
    };
  };
  const fileObserver = {
    subscribe,
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  let observedPath = trackedPath;
  let observedRelativePath = "src/tracked.txt";
  const readObservedState = () => {
    const contents = readFileSync(observedPath, "utf8");
    const isDirty = contents !== "base\n";
    return {
      isDirty,
      additions: isDirty ? contents.trim().split("\n").length : 0,
    };
  };
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createFacts(cwd));
  const getCheckoutStatus = vi.fn(async (cwd: string) => ({
    ...createStatus(cwd),
    isDirty: readObservedState().isDirty,
  }));
  const getCheckoutShortstat = vi.fn(async () => ({
    additions: readObservedState().additions,
    deletions: 0,
  }));
  const getCheckoutWorktreeState = vi.fn(async () => {
    const additions = readObservedState().additions;
    return { isDirty: true, diffStat: { additions, deletions: 0 } };
  });
  const getCheckoutDiff = vi.fn(async () => {
    const additions = readObservedState().additions;
    return {
      diff: "",
      structured: [
        { path: observedRelativePath, additions, deletions: 0, status: "modified" as const },
      ],
    };
  });
  let buildIgnored = true;
  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args[0] === "rev-parse") {
      return {
        stdout: `${repoDir}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    if (args[0] === "ls-files") {
      return {
        stdout: `${buildIgnored ? "build/\n" : ""}cache/\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    fileObserver,
    deps: {
      // The production interval has deterministic coverage; this contract
      // exercises real pruning without a 30-second wall-clock wait.
      getWorkingTreeIgnoreRefreshIntervalMs: () => 300,
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      getCheckoutDiff,
      runGitCommand,
    } as never,
  });
  const diffManager = new CheckoutDiffManager({
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    workspaceGitService: service,
  });
  const summaryListener = vi.fn();
  const diffListener = vi.fn();
  const summarySubscription = service.registerWorkspace({ cwd: repoDir }, summaryListener);
  const diffSubscription = await diffManager.subscribe(
    { cwd: repoDir, compare: { mode: "uncommitted" } },
    diffListener,
  );

  cleanup.push(async () => {
    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    await service.dispose();
    expect(activeWatcherCount).toBe(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  await vi.waitFor(
    () => {
      expect(activeWatcherCount).toBe(2);
      expect(service.peekSnapshot(repoDir)).not.toBeNull();
      expect(service.getMetrics()).toMatchObject({
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "base\n");
  await vi.waitFor(
    () => {
      const events = deliveredEvents.flatMap((batch) => batch.events);
      expect(events.map((event) => event.path)).toContain(trackedPath);
      expect(getCheckoutWorktreeState).toHaveBeenCalled();
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  deliveredEvents.length = 0;

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff, JSON.stringify(deliveredEvents)).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(ignoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  writeFileSync(trackedPath, "first\nsecond\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "src/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "first\nsecond\nthird\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            diffStat: { additions: 3, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ additions: 3 })],
        }),
      );
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();

  buildIgnored = false;
  observedPath = newlyTrackedPath;
  observedRelativePath = "build/tracked.txt";
  let editedDuringIgnoreUpdate = false;
  onWorkingTreeIgnoreUpdated = () => {
    editedDuringIgnoreUpdate = true;
    writeFileSync(newlyTrackedPath, "first\nsecond\n");
  };
  writeFileSync(path.join(repoDir, ".gitignore"), "cache/\n");
  await vi.waitFor(
    () => {
      expect(editedDuringIgnoreUpdate).toBe(true);
      expect(watcherStartCount).toBe(2);
      expect(activeWatcherCount).toBe(2);
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 8_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  summaryListener.mockClear();
  diffListener.mockClear();

  writeFileSync(newlyTrackedPath, "first\nsecond\nthird\nfourth\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 4, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 4,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(remainingIgnoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
}, 30_000);

test.each([".next", ".turbo", "node_modules", "dist", "coverage", "apps/web/.next"])(
  "a late Git-ignored %s tree is pruned while tracked changes still notify consumers",
  async (ignoredName) => {
    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-real-ignore-")));
    const repoDir = path.join(tempDir, "repo");
    mkdirSync(repoDir);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(path.join(repoDir, ".gitignore"), `${ignoredName}/\n`);
    const trackedRelativePath = path.join(path.dirname(ignoredName), "tracked.txt");
    const trackedPath = path.join(repoDir, trackedRelativePath);
    mkdirSync(path.dirname(trackedPath), { recursive: true });
    writeFileSync(trackedPath, "before\n");
    git("add", ".gitignore", trackedRelativePath);
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture");

    const observer = createFileObserver();
    const ignoredDir = path.join(repoDir, ignoredName);
    const completedIgnoreUpdates: string[][] = [];
    let notifications = 0;
    let expectTrackedEdit = false;
    let trackedBatchReachedConsumer = false;
    // Observe the real subscription without replacing Git, filesystem, or watcher behavior.
    const fileObserver: FileObserver = {
      subscribe: async (directory, callback, options) => {
        const realSubscription = await observer.subscribe(
          directory,
          (error, events) => {
            const includesTrackedEdit =
              expectTrackedEdit && events.some((e) => e.path === trackedPath);
            const before = notifications;
            callback(error, events);
            if (includesTrackedEdit && notifications > before) trackedBatchReachedConsumer = true;
          },
          options,
        );
        return {
          updateIgnore: async (paths) => {
            await realSubscription.updateIgnore(paths);
            completedIgnoreUpdates.push([...paths]);
          },
          unsubscribe: () => realSubscription.unsubscribe(),
        };
      },
      getDiagnostics: () => observer.getDiagnostics(),
      close: () => observer.close(),
    };
    const service = new WorkspaceGitServiceImpl({
      logger: pino({ enabled: false }),
      paseoHome: path.join(tempDir, "home"),
      fileObserver,
      deps: { getWorkingTreeIgnoreRefreshIntervalMs: () => 300 },
    });
    let subscription: Awaited<ReturnType<typeof service.requestWorkingTreeWatch>> | undefined;
    try {
      subscription = await service.requestWorkingTreeWatch(repoDir, () => {
        notifications += 1;
      });
      for (let index = 0; index < 20; index += 1) {
        const directory = path.join(ignoredDir, `dependency-${index}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "index.js"), "first");
      }
      expect(git("ls-files", "-o", "-i", "--directory", "--exclude-standard")).toBe(
        `${ignoredName}/`,
      );
      await expect
        .poll(() => completedIgnoreUpdates.some((paths) => paths.includes(ignoredDir)), {
          timeout: 5_000,
        })
        .toBe(true);

      const atIgnoreBoundary = observer.getDiagnostics();
      for (let index = 0; index < 20; index += 1) {
        writeFileSync(path.join(ignoredDir, `dependency-${index}`, "second.js"), "second");
      }
      expectTrackedEdit = true;
      writeFileSync(trackedPath, "after\n");
      await expect.poll(() => trackedBatchReachedConsumer, { timeout: 5_000 }).toBe(true);
      const afterTrackedEdit = observer.getDiagnostics();
      expect(afterTrackedEdit.nativeHandleCount).toBe(atIgnoreBoundary.nativeHandleCount);
      expect(afterTrackedEdit.nativeTrackedFileCount).toBe(atIgnoreBoundary.nativeTrackedFileCount);
      expect(
        afterTrackedEdit.nativeClassificationCount - atIgnoreBoundary.nativeClassificationCount,
      ).toBeLessThanOrEqual(1);
      // Inventory pruning alone leaves a recursive native handle covering build
      // output. Count raw callbacks too, after the updated ignore barrier.
      if (process.platform === "darwin") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          observer.getDiagnostics().nativeEventCount - atIgnoreBoundary.nativeEventCount,
        ).toBeLessThanOrEqual(4);
      }
    } finally {
      subscription?.unsubscribe();
      await service.dispose();
      await observer.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
  15_000,
);
