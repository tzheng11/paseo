import { createPaseoToolCatalog } from "./agent/tools/paseo-tools.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { resolveWorkspaceLayoutMode } from "./workspace-layout-mode.js";
import { randomUUID } from "node:crypto";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { CanonicalWorkspaceRegistry } from "./workspace-layout-registry.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  emptyWorkspaceNavigationPreferences,
  qualifyLegacyWorkspaceLayoutEntries,
} from "@getpaseo/protocol/workspace-layout";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { getPaseoWorktreeMetadataPath } from "../utils/worktree-metadata.js";
import { archiveCommand } from "./worktree/commands.js";
import { createWorktree, listPaseoWorktrees, type WorktreeConfig } from "../utils/worktree.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";
import { WorkspaceAutomationBlockedError } from "./workspace-automation-gate.js";
import { NativeWatchHost } from "./file-observer/internal/native-watch-client.js";
import * as atomicFile from "./atomic-file.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "workspace-archive-service-"));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir };
}

async function createPaseoOwnedWorktree(
  repoDir: string,
  paseoHome: string,
  worktreeSlug: string,
): Promise<WorktreeConfig> {
  return createWorktree({
    cwd: repoDir,
    worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: "main",
      branchName: worktreeSlug,
    },

    paseoHome,
  });
}

interface ArchiveDepsInput {
  paseoHome: string;
  activeWorkspaces: ActiveWorkspaceRef[];
  paseoWorktreesBaseRoot?: string;
  findWorkspaceIdForCwd?: (cwd: string) => Promise<string | null>;
}

interface ArchiveTestDependencies extends ArchiveDependencies {
  activeWorkspaces: ActiveWorkspaceRef[];
  archivedAgentIds: string[];
  archivedSnapshotIds: string[];
}

function createArchiveDeps(input: ArchiveDepsInput): ArchiveTestDependencies {
  const archivedWorkspaceIds = new Set<string>();
  const active = [...input.activeWorkspaces];
  const archivedAgentIds: string[] = [];
  const archivedSnapshotIds: string[] = [];

  return {
    paseoHome: input.paseoHome,
    paseoWorktreesBaseRoot: input.paseoWorktreesBaseRoot,
    github: createGitHubServiceStub(),
    workspaceGitService: {
      getSnapshot: vi.fn(async () => null),
      invalidateWorktrees: () => {},
    } as unknown as Pick<WorkspaceGitService, "getSnapshot" | "invalidateWorktrees">,
    agentManager: {
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: vi.fn(async (agentId: string) => {
        archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        archivedSnapshotIds.push(agentId);
        return {};
      }),
    },
    agentStorage: {
      listByWorkspace: async (): Promise<StoredAgentRecord[]> => [],
    } as Pick<AgentStorage, "listByWorkspace">,
    findWorkspaceIdForCwd: input.findWorkspaceIdForCwd ?? vi.fn(async () => null),
    listActiveWorkspaces: async () =>
      active.filter((workspace) => !archivedWorkspaceIds.has(workspace.workspaceId)),
    archiveWorkspaceRecord: async (workspaceId: string) => {
      archivedWorkspaceIds.add(workspaceId);
      const index = active.findIndex((workspace) => workspace.workspaceId === workspaceId);
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    killTerminalsForWorkspace: vi.fn(async () => {}),
    sessionLogger: createLogger(),
    activeWorkspaces: active,
    archivedAgentIds,
    archivedSnapshotIds,
  };
}

function assertArchiveResult(
  result: ArchiveResult,
  expected: {
    archivedWorkspaceIds: string[];
    removedDirectory: boolean;
  },
): void {
  expect(result.archivedWorkspaceIds).toEqual(expected.archivedWorkspaceIds);
  expect(result.removedDirectory).toBe(expected.removedDirectory);
}

describe("archiveByScope", () => {
  test("refuses canonical-mode retirement before any agent, terminal or worktree effect", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "canonical-archive-"));
    cleanupPaths.push(home);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ version: 1, workspaceLayout: {} }),
    );
    const deps = createArchiveDeps({
      paseoHome: home,
      activeWorkspaces: [{ workspaceId: "retained", cwd: home, kind: "local_checkout" }],
    });
    const archiveAgent = vi.spyOn(deps.agentManager, "archiveAgent");
    const terminals = vi.spyOn(deps, "killTerminalsForWorkspace");
    const records = vi.spyOn(deps, "archiveWorkspaceRecord");
    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: "retained" },
        requestId: "central",
      }),
    ).rejects.toThrow("canonical_retirement_reservation_required");
    expect(archiveAgent).not.toHaveBeenCalled();
    expect(terminals).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
    expect(deps.activeWorkspaces).toHaveLength(1);
  });
  test("failed agent teardown cannot report its workspace archived", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const deps = createArchiveDeps({
      paseoHome: tempDir,
      activeWorkspaces: [{ workspaceId: "failure", cwd: repoDir, kind: "local_checkout" }],
    });
    deps.agentStorage.listByWorkspace = async () => [
      { id: "unloaded", workspaceId: "failure", archivedAt: null } as StoredAgentRecord,
    ];
    deps.agentManager.archiveSnapshot = async () => {
      throw new Error("agent archive failed");
    };
    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "failure" },
      requestId: "failure",
    });
    expect(result.archivedWorkspaceIds).toEqual([]);
    expect(result.archivedAgentIds).toEqual([]);
    expect(result.removedDirectory).toBe(false);
    expect((await deps.listActiveWorkspaces()).map((workspace) => workspace.workspaceId)).toEqual([
      "failure",
    ]);
  });

  test("archives through a 120-second native unwatch hang and restarts the bounded child", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, "paseo-home");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "hung-unwatch");
    const entry = path.join(tempDir, "fault-host.mjs");
    const entered = path.join(tempDir, "unwatch-entered");
    // Model a native unsubscribe that cannot service IPC for 120 seconds. This
    // sleeps in the child; it creates no synthetic CPU load on the daemon host.
    writeFileSync(
      entry,
      `
      import { writeFileSync } from 'node:fs';
      const roots = new Map();
      process.on('message', command => {
        if (command.action === 'watch') {
          roots.set(command.id, command.input.root);
          process.send({action:'ready', id:command.id});
        }
        else {
          if (roots.get(command.id) === ${JSON.stringify(worktree.worktreePath)}) {
            writeFileSync(${JSON.stringify(entered)}, String(process.pid));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
          }
          process.send({action:'closed', id:command.id});
        }
      });
      process.on('disconnect', () => process.exit(0));
    `,
    );
    const children: ChildProcess[] = [];
    const host = new NativeWatchHost({
      entry: pathToFileURL(entry),
      fork: (...args) => {
        const child = fork(...args);
        children.push(child);
        return child;
      },
      // Use the production 30-second bound, not a shortened test deadline.
    });
    const watch = host.watch({ root: worktree.worktreePath, kind: "parcel" }, () => {});
    await watch.ready;
    const child = children[0]!;
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId: "ws-hung-unwatch",
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    const archiveRecord = deps.archiveWorkspaceRecord;
    let closeMs = 0;
    deps.archiveWorkspaceRecord = async (workspaceId) => {
      const start = performance.now();
      await watch.close();
      closeMs = performance.now() - start;
      await archiveRecord(workspaceId);
    };
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 50);
    const started = performance.now();
    try {
      const result = await archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: "ws-hung-unwatch" },
        requestId: "fault-unwatch",
      });
      const archiveMs = performance.now() - started;
      expect(readFileSync(entered, "utf8")).toBe(String(child.pid));
      expect(result.archivedWorkspaceIds).toEqual(["ws-hung-unwatch"]);
      expect(result.removedDirectory).toBe(true);
      expect(existsSync(worktree.worktreePath)).toBe(false);
      expect(closeMs).toBeGreaterThanOrEqual(29_000);
      expect(closeMs).toBeLessThan(35_000);
      expect(archiveMs).toBeLessThan(45_000);
      expect(child.signalCode).toBe("SIGKILL");
      // Prove the same host can spawn and register after terminating its wedge.
      const replacement = host.watch({ root: repoDir, kind: "parcel" }, () => {});
      await replacement.ready;
      expect(children).toHaveLength(2);
      expect(children[1]!.pid).not.toBe(child.pid);
      const maxDelayMs = histogram.max / 1e6;
      expect(maxDelayMs).toBeLessThan(1_000);
      expect(ticks).toBeGreaterThan(400);
      process.stdout.write(
        "native-close-fault-proof " +
          JSON.stringify({
            injectedHangMs: 120_000,
            productionTimeoutMs: 30_000,
            closeMs,
            archiveMs,
            maxDelayMs,
            ticks,
            killedPid: child.pid,
            replacementPid: children[1]!.pid,
            killedSignal: child.signalCode,
            archiveCompleted: result.removedDirectory,
          }) +
          "\n",
      );
      await replacement.close();
    } finally {
      clearInterval(heartbeat);
      histogram.disable();
      for (const ownedChild of children) {
        if (ownedChild.exitCode === null && ownedChild.signalCode === null)
          ownedChild.kill("SIGKILL");
      }
      await watch.close();
    }
  }, 60_000);

  test("bounds a stuck post-archive snapshot and handles its late rejection", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const workspaceId = "ws-stuck-refresh";
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId, cwd: repoDir, kind: "directory", mainRepoRoot: repoDir }],
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let rejectSnapshot!: (error: Error) => void;
    deps.workspaceGitService.getSnapshot = vi.fn(() => {
      entered();
      return new Promise((_, reject) => {
        rejectSnapshot = reject;
      });
    });
    vi.useFakeTimers();
    try {
      const archive = archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-stuck-refresh",
      });
      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await archive).toMatchObject({
        archivedWorkspaceIds: [workspaceId],
        removedDirectory: false,
      });
      expect(deps.clearWorkspaceArchiving).toHaveBeenCalledWith([workspaceId]);
      expect(deps.sessionLogger?.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            message: expect.stringContaining("Timed out after 5000ms"),
          }),
        }),
        "Failed to force-refresh workspace git snapshot after archiving",
      );
      rejectSnapshot(new Error("late refresh failure"));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["workspace", "worktree"] as const)(
    "%s archive preserves a restored external worktree despite its marker",
    async (kind) => {
      const { tempDir, repoDir } = createGitRepo();
      const paseoHome = path.join(tempDir, ".paseo");
      const recordedPath = path.join(tempDir, "external");
      execFileSync("git", ["worktree", "add", "-b", "external", recordedPath], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["worktree", "remove", recordedPath], { cwd: repoDir, stdio: "pipe" });
      const restored = await createWorktree({
        cwd: repoDir,
        paseoHome,
        worktreeSlug: "external",
        worktreePath: recordedPath,
        source: { kind: "restore", branchName: "external", baseRef: "main" },
      });
      expect(existsSync(await getPaseoWorktreeMetadataPath(restored.worktreePath))).toBe(true);
      const workspaceId = "external-workspace";
      const result = await archiveByScope(
        createArchiveDeps({
          paseoHome,
          activeWorkspaces: [
            {
              workspaceId,
              cwd: restored.worktreePath,
              kind: "worktree",
              worktreeRoot: restored.worktreePath,
              mainRepoRoot: repoDir,
              isPaseoOwnedWorktree: false,
            },
          ],
        }),
        {
          scope:
            kind === "workspace"
              ? { kind, workspaceId }
              : { kind, targetPath: restored.worktreePath },
          requestId: "archive-external",
        },
      );
      expect(result.removedDirectory).toBe(false);
      expect(existsSync(restored.worktreePath)).toBe(true);
      expect(result.archivedWorkspaceIds).toEqual([workspaceId]);
    },
  );

  test("workspace scope archives the record and removes the directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "last-ref-workspace");
    const workspaceId = "ws-last-ref";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-last-ref-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace scope archives the record but leaves a plugin-placed directory whose marker is gone", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "unproven-workspace",
      source: { kind: "branch-off", baseBranch: "main", branchName: "unproven-workspace" },
      paseoHome,
      worktreePath: path.join(tempDir, "placed-worktree"),
    });
    // Remove the ownership marker: no proof remains for this path.
    rmSync(await getPaseoWorktreeMetadataPath(worktree.worktreePath), { force: true });
    const workspaceId = "ws-unproven";

    const logs: Array<{ targetPath: string; msg: string }> = [];
    const dependencies = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    dependencies.sessionLogger = pino(
      { level: "warn" },
      {
        write(message) {
          logs.push(JSON.parse(message));
        },
      },
    );
    const result = await archiveByScope(dependencies, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-unproven-workspace",
    });

    assertArchiveResult(result, { archivedWorkspaceIds: [workspaceId], removedDirectory: false });
    expect(result.directoryLeftBehind?.path).toBe(worktree.worktreePath);
    expect(result.directoryLeftBehind?.reason).toContain("no ownership proof");
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({
        targetPath: worktree.worktreePath,
        msg: expect.stringContaining("no ownership proof"),
      }),
    );
  });

  test("archives a plugin-placed worktree by its discovered directory name", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = path.join(tempDir, "sibling-feature");
    await createWorktree({
      cwd: repoDir,
      paseoHome,
      worktreePath,
      worktreeSlug: "original-slug",
      source: { kind: "branch-off", branchName: "feature", baseBranch: "main" },
    });
    const dependencies = createArchiveDeps({ paseoHome, activeWorkspaces: [] });
    const result = await archiveCommand(
      {
        ...dependencies,
        workspaceGitService: {
          ...dependencies.workspaceGitService,
          listWorktrees: (cwd) => listPaseoWorktrees({ cwd, paseoHome }),
        },
      },
      {
        repoRoot: repoDir,
        worktreeSlug: "sibling-feature",
        scope: "worktree",
        requestId: "slug-archive",
      },
    );
    expect(result).toEqual({ ok: true, removedAgents: [] });
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("workspace scope deletes a plugin-placed directory on registry proof even with the marker gone", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "registry-proven-workspace",
      source: {
        kind: "branch-off",
        baseBranch: "main",
        branchName: "registry-proven-workspace",
      },
      paseoHome,
      worktreePath: path.join(tempDir, "placed-worktree"),
    });
    rmSync(await getPaseoWorktreeMetadataPath(worktree.worktreePath), { force: true });
    const workspaceId = "ws-registry-proven";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            isPaseoOwnedWorktree: true,
            worktreeRoot: worktree.worktreePath,
            mainRepoRoot: repoDir,
          },
        ],
      }),
      { scope: { kind: "workspace", workspaceId }, requestId: "req-registry-proven-workspace" },
    );

    assertArchiveResult(result, { archivedWorkspaceIds: [workspaceId], removedDirectory: true });
    expect(result.directoryLeftBehind).toBeUndefined();
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace scope runs teardown while keeping a directory referenced by a sibling", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/shared-teardown.log', 'ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "sibling-workspace");
    const workspaceA = "ws-sibling-a";
    const workspaceB = "ws-sibling-b";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: workspaceA },
        requestId: "req-sibling-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceA],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(readFileSync(path.join(repoDir, "shared-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope skips teardown while repository automation is blocked", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const marker = path.join(repoDir, "blocked-teardown.log");
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [`node -e "require('fs').writeFileSync('${marker}', 'unsafe')"`],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "blocked teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "blocked-teardown");
    const workspaceId = "ws-blocked-teardown";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.assertWorkspaceAutomationAllowed = async () => {
      throw new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      });
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-blocked-teardown",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceId]);
    expect(existsSync(marker)).toBe(false);
  });

  test("workspace scope keeps a worktree for an active workspace in a subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-sibling");
    const sourceWorkspaceId = "ws-subdirectory-source";
    const siblingWorkspaceId = "ws-subdirectory-sibling";
    const siblingDirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(siblingDirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: sourceWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: siblingWorkspaceId,
            cwd: siblingDirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: sourceWorkspaceId },
        requestId: "req-subdirectory-sibling",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [sourceWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("archiving a subdirectory workspace keeps its active worktree root", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-target");
    const rootWorkspaceId = "ws-subdirectory-root";
    const subdirectoryWorkspaceId = "ws-subdirectory-target";
    const subdirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(subdirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: rootWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: subdirectoryWorkspaceId,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: subdirectoryWorkspaceId },
        requestId: "req-subdirectory-target",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [subdirectoryWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope runs teardown from the exact nested workspace before deleting its worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/nested-teardown.log', process.cwd())\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "nested teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "nested-teardown");
    const workspaceCwd = path.join(worktree.worktreePath, nestedRelative);
    const matchesWorkspaceCwd = createRealpathAwarePathMatcher(workspaceCwd);
    const workspaceId = "ws-nested-teardown";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: workspaceCwd,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: repoDir,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-nested-teardown",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(
      matchesWorkspaceCwd(readFileSync(path.join(repoDir, "nested-teardown.log"), "utf8")),
    ).toBe(true);
  });

  test("worktree scope archives root and subdirectory workspaces before removing the backing worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"const fs=require('fs');const out=process.env.PASEO_SOURCE_CHECKOUT_PATH+'/root-scope-teardown.log';if(fs.existsSync(out))process.exit(2);fs.writeFileSync(out,'ok')\"",
          ],
        },
      }),
    );
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+'/nested-scope-teardown.log','ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "scope teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope");
    const workspaceA = "ws-worktree-a";
    const workspaceB = "ws-worktree-b";
    const workspaceC = "ws-worktree-subdirectory";
    const subdirectory = path.join(worktree.worktreePath, nestedRelative);

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: workspaceA,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceB,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceC,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(readFileSync(path.join(repoDir, "root-scope-teardown.log"), "utf8")).toBe("ok");
    expect(readFileSync(path.join(repoDir, "nested-scope-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope never removes a non-Paseo-owned directory", async () => {
    const { tempDir } = createGitRepo();
    const localCheckoutDir = mkdtempSync(path.join(tempDir, "local-checkout-"));
    const workspaceId = "ws-local-checkout";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome: path.join(tempDir, ".paseo"),
        activeWorkspaces: [{ workspaceId, cwd: localCheckoutDir, kind: "local_checkout" }],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-local-checkout",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    });
    expect(existsSync(localCheckoutDir)).toBe(true);
  });

  test("worktree scope keeps the directory when one record teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "partial-failure");
    const workspaceA = "ws-partial-a";
    const workspaceB = "ws-partial-b";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (workspaceId: string) => {
      if (workspaceId === workspaceA) {
        throw new Error("intentional teardown failure");
      }
      return originalArchiveWorkspaceRecord(workspaceId);
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-failure",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(result.archivedWorkspaceIds).not.toContain(workspaceA);
    expect(result.removedDirectory).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope with unknown workspace id is a clean no-op", async () => {
    const { tempDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = vi.fn(async (workspaceId: string) => {
      return originalArchiveWorkspaceRecord(workspaceId);
    });

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-does-not-exist" },
      requestId: "req-unknown-workspace",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: false,
    });
    expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.emitWorkspaceUpdatesForWorkspaceIds).not.toHaveBeenCalled();
  });

  test.each(["intact", "missing"] as const)(
    "worktree scope removes an owned directory with zero matching records and %s Git administration",
    async (gitAdministration) => {
      const { tempDir, repoDir } = createGitRepo();
      const paseoHome = path.join(tempDir, ".paseo");
      const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "zero-records");
      if (gitAdministration === "missing") {
        const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: worktree.worktreePath,
        })
          .toString()
          .trim();
        rmSync(gitDir, { recursive: true, force: true });
      }
      const dependencies = createArchiveDeps({ paseoHome, activeWorkspaces: [] });
      const invalidateWorktrees = vi.fn();
      dependencies.workspaceGitService.invalidateWorktrees = invalidateWorktrees;

      const result = await archiveByScope(dependencies, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-zero-records",
      });

      assertArchiveResult(result, {
        archivedWorkspaceIds: [],
        removedDirectory: true,
      });
      expect(existsSync(worktree.worktreePath)).toBe(false);
      expect(invalidateWorktrees).toHaveBeenCalledTimes(1);
    },
  );

  test("marks archiving, emits an upsert carrying the archiving state, then clears it and emits a remove", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "lifecycle");
    const workspaceId = "ws-lifecycle";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });

    const archivingByWorkspaceId = new Map<string, string>();
    type LifecycleEvent =
      | { type: "mark"; workspaceIds: string[]; archivingAt: string }
      | {
          type: "emit";
          workspaceIds: string[];
          updates: Array<{
            kind: "upsert" | "remove";
            workspaceId: string;
            archivingAt: string | null;
          }>;
        }
      | { type: "archive"; workspaceId: string }
      | { type: "clear"; workspaceIds: string[] };
    const events: LifecycleEvent[] = [];

    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
      events.push({ type: "archive", workspaceId: id });
    };
    deps.markWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>, archivingAt: string) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.set(id, archivingAt);
      }
      events.push({ type: "mark", workspaceIds: Array.from(workspaceIds), archivingAt });
    });
    deps.clearWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.delete(id);
      }
      events.push({ type: "clear", workspaceIds: Array.from(workspaceIds) });
    });
    deps.emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async (workspaceIds: Iterable<string>) => {
      const ids = Array.from(workspaceIds);
      const activeIds = new Set<string>();
      for (const workspace of deps.activeWorkspaces) {
        activeIds.add(workspace.workspaceId);
      }
      const updates: Array<{
        kind: "upsert" | "remove";
        workspaceId: string;
        archivingAt: string | null;
      }> = [];
      for (const id of ids) {
        const archivingAt = archivingByWorkspaceId.get(id) ?? null;
        if (archivingAt && activeIds.has(id)) {
          updates.push({ kind: "upsert", workspaceId: id, archivingAt });
        } else {
          updates.push({ kind: "remove", workspaceId: id, archivingAt: null });
        }
      }
      events.push({ type: "emit", workspaceIds: ids, updates });
    });

    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-lifecycle",
    });

    expect(events.map((event) => event.type)).toEqual(["mark", "emit", "archive", "clear", "emit"]);

    const firstEmit = events[1] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(firstEmit.workspaceIds).toEqual([workspaceId]);
    expect(firstEmit.updates).toEqual([
      { kind: "upsert", workspaceId, archivingAt: expect.any(String) },
    ]);

    const secondEmit = events[4] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(secondEmit.workspaceIds).toEqual([workspaceId]);
    expect(secondEmit.updates).toEqual([{ kind: "remove", workspaceId, archivingAt: null }]);
  });

  test("archives stored snapshots only for the target workspace", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "snapshot-scope");
    const targetWorkspaceId = "ws-snapshot-target";
    const otherWorkspaceId = "ws-snapshot-other";
    const liveAgentId = "agent-live";
    const targetStoredAgentId = "agent-stored-target";
    const otherStoredAgentId = "agent-stored-other";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: targetWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.agentManager = {
      listAgents: () => [{ id: liveAgentId, workspaceId: targetWorkspaceId }] as ManagedAgent[],
      getAgent: (agentId: string) =>
        agentId === liveAgentId ? ({ id: liveAgentId } as ManagedAgent) : null,
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        return {};
      }),
    };
    deps.agentStorage = {
      listByWorkspace: async (workspaceId: string) =>
        workspaceId === targetWorkspaceId
          ? ([
              { id: targetStoredAgentId, workspaceId: targetWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[])
          : ([
              { id: otherStoredAgentId, workspaceId: otherWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[]),
    } as Pick<AgentStorage, "listByWorkspace">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: targetWorkspaceId },
      requestId: "req-snapshot-scope",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [targetWorkspaceId],
      removedDirectory: true,
    });
    expect(result.archivedAgentIds).toContain(liveAgentId);
    expect(result.archivedAgentIds).toContain(targetStoredAgentId);
    expect(result.archivedAgentIds).not.toContain(otherStoredAgentId);
    expect(deps.archivedSnapshotIds).toEqual([targetStoredAgentId]);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("archives the durable snapshot when an observed live agent closes before teardown", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const workspaceId = "ws-live-teardown-race";
    const agentId = "agent-live-teardown-race";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: repoDir, kind: "local_checkout" }],
    });
    deps.agentManager = {
      listAgents: () => [{ id: agentId, workspaceId }] as ManagedAgent[],
      getAgent: () => null,
      archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
      archiveSnapshot: vi.fn(async (id: string) => {
        deps.archivedSnapshotIds.push(id);
        return {};
      }),
    };
    deps.agentStorage = {
      list: async () => [{ id: agentId, workspaceId, archivedAt: null }] as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-live-teardown-race",
    });

    expect(result.archivedAgentIds).toContain(agentId);
    expect(deps.archivedSnapshotIds).toEqual([agentId]);
    expect(deps.agentManager.archiveAgent).not.toHaveBeenCalled();
  });

  test("worktree scope archives three workspaces on the directory and removes it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope-n3");
    const workspaceA = "ws-worktree-n3-a";
    const workspaceB = "ws-worktree-n3-b";
    const workspaceC = "ws-worktree-n3-c";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceC, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope-n3",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });
});

describe("resolveWorkspaceIdAtPath", () => {
  test("prefers the worktree-kind record on an exact cwd tie", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-local", cwd: targetPath, kind: "local_checkout" },
          { workspaceId: "ws-worktree", cwd: targetPath, kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-local"),
      },
      targetPath,
    );

    expect(result).toBe("ws-worktree");
  });

  test("falls back to the path resolver when there is no exact match", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-nested", cwd: "/worktrees/repo", kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-nested"),
      },
      targetPath,
    );

    expect(result).toBe("ws-nested");
  });
});

async function canonicalArchiveFixture(teardown?: string) {
  const { tempDir, repoDir } = createGitRepo();
  if (teardown) {
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({ worktree: { teardown: [teardown] } }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
  }
  const home = path.join(tempDir, "canonical-home");
  const worktree = await createPaseoOwnedWorktree(repoDir, home, "canonical-target");
  const config = {
    role: "authority" as const,
    authorityServerId: "owner",
    authorityId: "00000000-0000-4000-8000-000000000001",
    epoch: "00000000-0000-4000-8000-000000000002",
    authorityKeySha256: "a".repeat(64),
    semanticsVersion: 2 as const,
  };
  await resolveWorkspaceLayoutMode(home, config);
  const layout = new WorkspaceLayoutService({
    home,
    serverId: "owner",
    config,
    failed: (error) => {
      throw error;
    },
  });
  const record = createPersistedWorkspaceRecord({
    workspaceId: "old-a",
    projectId: "project",
    cwd: worktree.worktreePath,
    kind: "worktree",
    displayName: "target",
    title: null,
    branch: "canonical-target",
    worktreeRoot: worktree.worktreePath,
    baseBranch: "main",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: repoDir,
    createdAt: "2026-11-19T18:00:00.000Z",
    updatedAt: "2026-11-19T18:00:00.000Z",
  });
  const file = path.join(home, "projects", "workspaces.json");
  const local = new FileBackedWorkspaceRegistry(file, createLogger());
  await local.upsert(record);
  let state = await layout.initialize(config);
  await layout.commit({
    writerVersion: 2,
    requestId: randomUUID(),
    expected: state.stamp,
    mutations: [
      { kind: "declare-unknown-owner", serverId: "studio" },
      {
        kind: "import-host",
        previousSourceSha256: null,
        source: {
          serverId: "owner",
          sourceSha256: "a".repeat(64),
          resolutionSha256: "b".repeat(64),
        },
        entries: qualifyLegacyWorkspaceLayoutEntries([
          {
            ref: { serverId: "owner", workspaceId: record.workspaceId },
            projectId: record.projectId,
            pinnedAt: null,
            superpinnedAt: null,
            parent: null,
            siblingOrder: null,
            pinPlacement: null,
            archivedAt: null,
            revision: 0,
          },
        ]),
      },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "0".repeat(64) },
      },
    ],
  });
  state = await layout.inspect();
  await layout.commit({
    writerVersion: 2,
    requestId: randomUUID(),
    expected: state.stamp,
    mutations: [
      {
        kind: "activate",
        requiredImports: state.imports,
        requiredOwnerDomains: state.ownerDomains,
      },
    ],
  });
  const registry = new CanonicalWorkspaceRegistry(file, createLogger(), layout, "owner");
  await registry.initialize();
  const deps = createArchiveDeps({ paseoHome: home, activeWorkspaces: [record] });
  deps.retirementAuthority = layout;
  deps.listRetirementRecords = () => registry.listRetirementRecords();
  deps.getWorkspace = (id) => registry.get(id);
  deps.listActiveWorkspaces = async () => (await registry.list()).filter((row) => !row.archivedAt);
  deps.archiveWorkspaceRecord = async (id) => {
    await registry.archive(id, new Date().toISOString());
  };
  return {
    deps,
    registry,
    layout,
    record,
    worktree,
    repoDir,
    home,
    close: async () => {
      await registry.close();
      await layout.close();
    },
  };
}

test("canonical normal archive removes an eligible owned worktree only after a durable retirement receipt", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "normal-archive",
    });
    expect(result.retirement?.state).toBe("complete");
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(f.worktree.worktreePath)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: f.repoDir,
        encoding: "utf8",
      }),
    ).not.toContain(f.worktree.worktreePath);
    expect((await f.layout.inspect()).retirements?.[0].state).toBe("complete");
    expect(
      JSON.parse(readFileSync(path.join(f.home, "workspace-layout.json"), "utf8")).schemaVersion,
    ).toBe(5);
  } finally {
    await f.close();
  }
});
test("canonical kept slot admits new native ID B at the same path and old A replay touches no B resources", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const sentinel = path.join(f.worktree.worktreePath, "uncommitted-owned-source");
    writeFileSync(sentinel, "retained");
    const request = {
      scope: { kind: "workspace" as const, workspaceId: "old-a" },
      requestId: "archive-a",
    };
    const first = await archiveByScope(f.deps, request);
    expect(first.retirement?.state).toBe("complete");
    expect(first.slotKept).toBe(true);
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T19:00:00.000Z",
      updatedAt: "2026-11-19T19:00:00.000Z",
    });
    mkdirSync(path.join(f.worktree.worktreePath, "node_modules"));
    writeFileSync(path.join(f.worktree.worktreePath, "node_modules", "b"), "new dependencies");
    const before = await f.registry.get("new-b");
    const killCount = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    const replay = await archiveByScope(f.deps, { ...request, requestId: "delayed-old-callback" });
    expect(replay).toEqual(first);
    expect(await f.registry.get("new-b")).toEqual(before);
    expect(readFileSync(sentinel, "utf8")).toBe("retained");
    expect(readFileSync(path.join(f.worktree.worktreePath, "node_modules", "b"), "utf8")).toBe(
      "new dependencies",
    );
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(killCount);
  } finally {
    await f.close();
  }
});

test.each(["reserve-retirement", "archive-retirement", "complete-retirement"])(
  "canonical %s lost acknowledgement is reconciled from the same durable receipt",
  async (mutationKind) => {
    const f = await canonicalArchiveFixture();
    const original = f.layout.commit.bind(f.layout);
    let lost = false;
    vi.spyOn(f.layout, "commit").mockImplementation(async (input) => {
      const receipt = await original(input);
      if (!lost && input.mutations[0].kind === mutationKind) {
        lost = true;
        throw new Error("fixture lost acknowledgement");
      }
      return receipt;
    });
    try {
      const result = await archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "lost-ack",
      });
      expect(result.retirement?.state).toBe("complete");
      expect((await f.layout.inspect()).retirements).toHaveLength(1);
      expect(existsSync(f.worktree.worktreePath)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each(["archive-retirement", "complete-retirement"])(
  "canonical authority loss before %s reports partial and never repeats teardown on replay",
  async (mutationKind) => {
    const f = await canonicalArchiveFixture();
    const original = f.layout.commit.bind(f.layout);
    const commit = vi.spyOn(f.layout, "commit").mockImplementation(async (input) => {
      if (input.mutations[0].kind === mutationKind)
        throw new Error("fixture authority unavailable at transition");
      return original(input);
    });
    const archive = vi.fn(f.deps.archiveWorkspaceRecord);
    f.deps.archiveWorkspaceRecord = archive;
    try {
      const request = {
        scope: { kind: "workspace" as const, workspaceId: "old-a" },
        requestId: "authority-transition-loss",
      };
      const outcome = await archiveByScope(f.deps, request);
      expect(outcome.retirement?.state).toBe("partial");
      expect(archive).toHaveBeenCalledTimes(1);
      expect(existsSync(f.worktree.worktreePath)).toBe(mutationKind === "archive-retirement");
      const calls = commit.mock.calls.length;
      const replay = await archiveByScope(f.deps, { ...request, requestId: "same-operation" });
      expect(replay.retirement?.operationId).toBe(outcome.retirement?.operationId);
      expect(replay.retirement?.state).toBe("partial");
      expect(commit).toHaveBeenCalledTimes(calls);
      expect(archive).toHaveBeenCalledTimes(1);
      expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["stop-setups", "started", 0],
  ["terminals:old-a", "done", 1],
] as const)(
  "canonical journal loss at %s/%s leaves partial evidence and never repeats the effect",
  async (step, phase, terminalEffects) => {
    const f = await canonicalArchiveFixture();
    const write = atomicFile.writeFileDurably;
    const writer = vi
      .spyOn(atomicFile, "writeFileDurably")
      .mockImplementation(async (file, bytes) => {
        if (file.startsWith(path.join(f.home, "workspace-retirements"))) {
          const journal = JSON.parse(bytes) as { steps: Record<string, string> };
          if (journal.steps[step] === phase) throw new Error("fixture journal disk failure");
        }
        return write(file, bytes);
      });
    try {
      const request = {
        scope: { kind: "workspace" as const, workspaceId: "old-a" },
        requestId: "journal-loss-at-effect",
      };
      const outcome = await archiveByScope(f.deps, request);
      expect(outcome.retirement).toMatchObject({
        state: "partial",
        code: "retirement_journal_persistence_failed",
      });
      expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(terminalEffects);
      writer.mockRestore();
      const replay = await archiveByScope(f.deps, { ...request, requestId: "query-durable-state" });
      expect(replay.retirement?.operationId).toBe(outcome.retirement?.operationId);
      expect(replay.retirement?.state).toBe("partial");
      expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(terminalEffects);
      expect((await f.layout.inspect()).retirements![0].state).toBe("reserved");
      expect(existsSync(f.worktree.worktreePath)).toBe(true);
    } finally {
      writer.mockRestore();
      await f.close();
    }
  },
);

test("canonical authority loss before reservation has zero teardown effects and retries only query the original operation", async () => {
  const f = await canonicalArchiveFixture();
  const original = f.layout.commit.bind(f.layout);
  const commit = vi.spyOn(f.layout, "commit").mockImplementation(async (input) => {
    if (input.mutations[0].kind === "reserve-retirement")
      throw new Error("fixture authority unavailable");
    return original(input);
  });
  try {
    const first = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "unavailable",
    });
    expect(first.retirement?.state).toBe("partial");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    const again = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "query-original",
    });
    expect(again.retirement?.operationId).toBe(first.retirement?.operationId);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});

test("canonical partial native teardown remains fenced after reopening and completed effects are never repeated", async () => {
  const f = await canonicalArchiveFixture();
  const archive = vi.fn(async () => {
    throw new Error("fixture native write unavailable");
  });
  f.deps.archiveWorkspaceRecord = archive;
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "native-failure",
  };
  try {
    const first = await archiveByScope(f.deps, request);
    expect(first.retirement?.state).toBe("partial");
    expect(archive).toHaveBeenCalledTimes(1);
    expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(1);
    const reopened = new WorkspaceLayoutService({
      ...f.layout.options,
      failed: (error) => {
        throw error;
      },
    });
    await reopened.load();
    f.deps.retirementAuthority = reopened;
    try {
      const again = await archiveByScope(f.deps, { ...request, requestId: "reopened-query" });
      expect(again.retirement?.operationId).toBe(first.retirement?.operationId);
      expect(archive).toHaveBeenCalledTimes(1);
      expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(1);
      await expect(f.registry.upsert({ ...f.record, workspaceId: "new-b" })).rejects.toThrow(
        "retirement_backing_reserved",
      );
      expect((await reopened.inspect()).retirements?.[0].state).toBe("reserved");
      expect(existsSync(f.worktree.worktreePath)).toBe(true);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("canonical affected quarantined native aliases refuse before setup or terminal teardown", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const native = new FileBackedWorkspaceRegistry(
      path.join(f.home, "projects", "workspaces.json"),
      createLogger(),
    );
    await native.initialize();
    await native.upsert({ ...f.record, workspaceId: "unimported-alias" });
    // A fresh canonical registry sees both local rows; publication quarantines the unimported one.
    const registry = new CanonicalWorkspaceRegistry(
      path.join(f.home, "projects", "workspaces.json"),
      createLogger(),
      f.layout,
      "owner",
    );
    await registry.initialize();
    f.deps.listRetirementRecords = () => registry.listRetirementRecords();
    f.deps.getWorkspace = (id) => registry.get(id);
    try {
      await expect(
        archiveByScope(f.deps, {
          scope: { kind: "workspace", workspaceId: "old-a" },
          requestId: "unknown-alias",
        }),
      ).rejects.toThrow("retirement_affected_owner_unknown");
      expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
      expect((await f.layout.inspect()).retirements).toBeUndefined();
    } finally {
      await registry.close();
    }
  } finally {
    await f.close();
  }
});

test.each(["pin", "title"])(
  "canonical native %s hold refuses before resource effects",
  async (kind) => {
    const f = await canonicalArchiveFixture();
    try {
      if (kind === "title")
        await f.registry.update("old-a", (record) => ({
          ...record,
          title: "do not archive (STOP)",
        }));
      else
        await f.registry.update("old-a", (record) => ({
          ...record,
          pinnedAt: "2026-11-19T19:00:00.000Z",
        }));
      await expect(
        archiveByScope(f.deps, {
          scope: { kind: "workspace", workspaceId: "old-a" },
          requestId: "held",
        }),
      ).rejects.toThrow("retirement_native_hold");
      expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
      expect(existsSync(f.worktree.worktreePath)).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test("a delayed async effect from A loses its execution lease before B reuses the kept slot", async () => {
  const f = await canonicalArchiveFixture();
  const { workspaceRetirementStep } = await import("./workspace-retirement.js");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed: Promise<void> | undefined;
  const effect = vi.fn(async () => {
    writeFileSync(path.join(f.worktree.worktreePath, "new-b-service-stopped"), "bad");
  });
  const original = f.deps.archiveWorkspaceRecord;
  f.deps.archiveWorkspaceRecord = async (id) => {
    await original(id);
    delayed = gate.then(() => workspaceRetirementStep("delayed-old-service-cleanup", effect));
    void delayed.catch(() => {});
  };
  try {
    writeFileSync(path.join(f.worktree.worktreePath, "owned-uncommitted-source"), "keep");
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "late-effect",
    });
    expect(result.retirement?.state).toBe("complete");
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T20:00:00.000Z",
      updatedAt: "2026-11-19T20:00:00.000Z",
    });
    release();
    await expect(delayed).rejects.toThrow("retirement_execution_closed");
    expect(effect).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.worktree.worktreePath, "new-b-service-stopped"))).toBe(false);
  } finally {
    release();
    await delayed?.catch(() => {});
    await f.close();
  }
});

test("a delayed path archive cannot select B with A's earlier backing generation", async () => {
  const f = await canonicalArchiveFixture();
  const { nativeGeneration } = await import("./workspace-retirement.js");
  try {
    writeFileSync(path.join(f.worktree.worktreePath, "owned-uncommitted-source"), "keep");
    const generation = nativeGeneration([f.record]);
    const request = {
      scope: {
        kind: "worktree" as const,
        targetPath: f.worktree.worktreePath,
        expectedBackingGeneration: generation,
      },
      requestId: "path-a",
    };
    expect((await archiveByScope(f.deps, request)).retirement?.state).toBe("complete");
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T20:00:00.000Z",
      updatedAt: "2026-11-19T20:00:00.000Z",
    });
    const before = await f.registry.get("new-b");
    const count = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    await expect(
      archiveByScope(f.deps, { ...request, requestId: "delayed-path-a" }),
    ).rejects.toThrow("canonical_backing_generation_required_or_changed");
    expect(await f.registry.get("new-b")).toEqual(before);
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(count);
  } finally {
    await f.close();
  }
});

test("canonical removal preserves source introduced at a real teardown boundary", async () => {
  const f = await canonicalArchiveFixture(
    `node -e "require('fs').writeFileSync('late-owned-source','preserve')"`,
  );
  try {
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "source-change",
    });
    expect(result.retirement?.state).toBe("complete");
    expect(result.removedDirectory).toBe(false);
    expect(result.slotKept).toBe(true);
    expect(result.directoryLeftBehind?.reason).toBe("source_changed_before_removal");
    expect(readFileSync(path.join(f.worktree.worktreePath, "late-owned-source"), "utf8")).toBe(
      "preserve",
    );
  } finally {
    await f.close();
  }
});

test("canonical failed teardown is partial and never reruns its uncertain command", async () => {
  const f = await canonicalArchiveFixture("exit 7");
  try {
    const request = {
      scope: { kind: "workspace" as const, workspaceId: "old-a" },
      requestId: "failed-teardown",
    };
    const first = await archiveByScope(f.deps, request);
    expect(first.retirement?.state).toBe("partial");
    expect(first.archivedWorkspaceIds).toEqual(["old-a"]);
    const count = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    const replay = await archiveByScope(f.deps, { ...request, requestId: "query-failed-teardown" });
    expect(replay.retirement?.operationId).toBe(first.retirement?.operationId);
    expect(replay.archivedWorkspaceIds).toEqual(["old-a"]);
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(count);
    await expect(f.registry.assertBackingWriteAllowed(f.worktree.worktreePath)).rejects.toThrow(
      "retirement_backing_reserved",
    );
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});

test("canonical reservation blocks pin and new-child races while allowing unrelated authority work", async () => {
  const f = await canonicalArchiveFixture();
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.deps.stopWorkspaceSetup = async () => {
    entered();
    await gate;
  };
  const archiving = archiveByScope(f.deps, {
    scope: { kind: "workspace", workspaceId: "old-a" },
    requestId: "race",
  });
  try {
    await started;
    const snapshot = await f.layout.inspect();
    const target = snapshot.entries[0];
    await expect(
      f.layout.commit({
        writerVersion: 3,
        requestId: randomUUID(),
        expected: snapshot.stamp,
        mutations: [{ kind: "put", entry: { ...target, pinnedAt: "2026-11-19T19:00:00.000Z" } }],
      }),
    ).rejects.toThrow("retirement_conflict");
    await expect(
      f.layout.commit({
        writerVersion: 3,
        requestId: randomUUID(),
        expected: snapshot.stamp,
        mutations: [
          {
            kind: "put",
            entry: {
              ...target,
              ref: { serverId: "owner", workspaceId: "new-child" },
              archivedAt: null,
              parent: target.ref,
              revision: 0,
            },
          },
        ],
      }),
    ).rejects.toThrow("retirement_conflict");
    release();
    expect((await archiving).retirement?.state).toBe("complete");
  } finally {
    release();
    await archiving;
    await f.close();
  }
});

test("canonical reservation refusal is terminal evidence and a later explicit admission can succeed after unpinning", async () => {
  const f = await canonicalArchiveFixture();
  const original = f.layout.commit.bind(f.layout);
  let race = true;
  vi.spyOn(f.layout, "commit").mockImplementation(async (input) => {
    if (race && input.mutations[0].kind === "reserve-retirement") {
      race = false;
      await f.registry.update("old-a", (record) => ({
        ...record,
        pinnedAt: "2026-11-19T19:00:00.000Z",
      }));
    }
    return original(input);
  });
  try {
    const first = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "pin-raced",
    });
    expect(first.retirement).toMatchObject({ state: "partial", code: "entry_revision_conflict" });
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect((await f.layout.inspect()).retirements).toBeUndefined();
    await f.registry.update("old-a", (record) => ({ ...record, pinnedAt: null }));
    const next = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "fresh-after-unpin",
    });
    expect(next.retirement?.state).toBe("complete");
    expect(next.retirement?.operationId).not.toBe(first.retirement?.operationId);
    expect(
      existsSync(
        path.join(
          f.home,
          "workspace-retirements",
          "history",
          `${first.retirement!.operationId}.json`,
        ),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("canonical missing owner journal is unknown state and cannot admit backing reuse", async () => {
  const f = await canonicalArchiveFixture();
  f.deps.archiveWorkspaceRecord = async () => {
    throw new Error("fixture interrupted native archive");
  };
  try {
    expect(
      (
        await archiveByScope(f.deps, {
          scope: { kind: "workspace", workspaceId: "old-a" },
          requestId: "journal-loss",
        })
      ).retirement?.state,
    ).toBe("partial");
    const { readdir, rm } = await import("node:fs/promises");
    for (const file of await readdir(path.join(f.home, "workspace-retirements")))
      await rm(path.join(f.home, "workspace-retirements", file));
    await expect(f.registry.upsert({ ...f.record, workspaceId: "new-b" })).rejects.toThrow(
      "retirement_owner_journal_missing",
    );
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});

test("canonical project admission checks every backing before any effects, including a pending shared second path", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const firstPath = path.join(f.repoDir, "other-checkout");
    mkdirSync(firstPath);
    await f.registry.upsert({
      ...f.record,
      workspaceId: "project-first",
      projectId: "retire-project",
      cwd: firstPath,
      worktreeRoot: null,
      kind: "local_checkout",
      isPaseoOwnedWorktree: false,
    });
    await f.registry.upsert({
      ...f.record,
      workspaceId: "shared-b",
      projectId: "retire-project",
    });
    const original = f.deps.archiveWorkspaceRecord;
    f.deps.archiveWorkspaceRecord = async () => {
      throw new Error("fixture interrupted old A");
    };
    const partial = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "reserve-shared-old-a",
    });
    expect(partial.retirement?.state).toBe("partial");
    f.deps.archiveWorkspaceRecord = original;
    const terminalCount = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    const markCount = vi.mocked(f.deps.markWorkspaceArchiving).mock.calls.length;
    const before = await f.layout.inspect();

    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "project", projectId: "retire-project" },
        requestId: "retire-multiple-backings",
      }),
    ).rejects.toThrow("retirement_backing_reserved");

    expect(await f.layout.inspect()).toEqual(before);
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(terminalCount);
    expect(vi.mocked(f.deps.markWorkspaceArchiving).mock.calls.length).toBe(markCount);
    expect((await f.registry.get("project-first"))?.archivedAt).toBeNull();
    expect((await f.registry.get("shared-b"))?.archivedAt).toBeNull();
  } finally {
    await f.close();
  }
});

test("canonical project keeps an archived hold despite a newer target on a different backing", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const otherPath = path.join(f.repoDir, "newer-checkout");
    mkdirSync(otherPath);
    await f.registry.upsert({
      ...f.record,
      workspaceId: "newer-other",
      cwd: otherPath,
      worktreeRoot: null,
      kind: "local_checkout",
      isPaseoOwnedWorktree: false,
      createdAt: "2026-11-19T19:00:00.000Z",
      updatedAt: "2026-11-19T19:00:00.000Z",
    });
    const inventory = f.deps.listRetirementRecords!;
    f.deps.listRetirementRecords = async () => [
      ...(await inventory()),
      {
        ...f.record,
        workspaceId: "held-archived",
        createdAt: "2026-11-19T17:00:00.000Z",
        archivedAt: "2026-11-19T18:30:00.000Z",
        updatedAt: "2026-11-19T18:30:00.000Z",
        title: "do not archive permanently",
      },
    ];
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "project", projectId: "project" },
        requestId: "unrelated-newer-is-not-release",
      }),
    ).rejects.toThrow("retirement_native_hold");
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect((await f.layout.inspect()).retirements).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("canonical worktree retirement reserves every same-backing alias before real removal", async () => {
  const f = await canonicalArchiveFixture();
  try {
    await f.registry.upsert({ ...f.record, workspaceId: "alias-b", kind: "local_checkout" });
    const { nativeGeneration } = await import("./workspace-retirement.js");
    const records = await f.registry.listRetirementRecords();
    const outcome = await archiveByScope(f.deps, {
      scope: {
        kind: "worktree",
        targetPath: f.worktree.worktreePath,
        expectedBackingGeneration: nativeGeneration(records),
      },
      requestId: "whole-backing",
    });
    expect(outcome.retirement?.state).toBe("complete");
    expect(outcome.archivedWorkspaceIds.toSorted()).toEqual(["alias-b", "old-a"]);
    expect(outcome.removedDirectory).toBe(true);
    expect(existsSync(f.worktree.worktreePath)).toBe(false);
    expect((await f.layout.inspect()).retirements![0].targets).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("canonical project retirement archives its whole multi-backing footprint and retains directories", async () => {
  const f = await canonicalArchiveFixture();
  try {
    const otherPath = path.join(f.repoDir, "other-checkout");
    mkdirSync(otherPath);
    await f.registry.upsert({
      ...f.record,
      workspaceId: "other-backing",
      cwd: otherPath,
      worktreeRoot: null,
      kind: "local_checkout",
      isPaseoOwnedWorktree: false,
    });
    const outcome = await archiveByScope(f.deps, {
      scope: { kind: "project", projectId: "project" },
      requestId: "whole-project",
    });
    expect(outcome.retirement?.state).toBe("complete");
    expect(outcome.archivedWorkspaceIds.toSorted()).toEqual(["old-a", "other-backing"]);
    expect(outcome.removedDirectory).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
    expect((await f.layout.inspect()).retirements![0].targets).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("canonical MCP archive uses the same reservation and returns its durable outcome", async () => {
  const f = await canonicalArchiveFixture();
  const logger = createLogger();
  const storage = new AgentStorage(path.join(f.home, "agents"), logger);
  const manager = new AgentManager({ clients: {}, registry: storage, logger });
  try {
    const catalog = await createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      workspaceRegistry: f.registry,
      workspaceLayoutService: f.layout,
      serverId: "owner",
      paseoHome: f.home,
      github: f.deps.github,
      workspaceGitService: createNoopWorkspaceGitService(),
      findWorkspaceIdForCwd: f.deps.findWorkspaceIdForCwd,
      listActiveWorkspaces: f.deps.listActiveWorkspaces,
      archiveWorkspaceRecord: f.deps.archiveWorkspaceRecord,
      emitWorkspaceUpdatesForWorkspaceIds: f.deps.emitWorkspaceUpdatesForWorkspaceIds,
      markWorkspaceArchiving: f.deps.markWorkspaceArchiving,
      clearWorkspaceArchiving: f.deps.clearWorkspaceArchiving,
      logger,
    });
    const result = await catalog.executeTool("archive_workspace", { workspaceId: "old-a" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      workspaceId: "old-a",
      removedDirectory: true,
      retirement: { state: "complete" },
    });
    expect((await f.layout.inspect()).retirements).toHaveLength(1);
    expect(existsSync(f.worktree.worktreePath)).toBe(false);
  } finally {
    await f.close();
  }
});

test("canonical clean removal cannot force-delete untracked source at the final Git boundary", async () => {
  const f = await canonicalArchiveFixture();
  const { deletePaseoWorktree } = await import("../utils/worktree.js");
  try {
    writeFileSync(path.join(f.worktree.worktreePath, "last-moment-owned-source"), "keep");
    await expect(
      deletePaseoWorktree({
        cwd: f.repoDir,
        worktreePath: f.worktree.worktreePath,
        paseoHome: f.home,
        registryProven: true,
        teardownCwds: [],
        requireCleanRemoval: true,
      }),
    ).rejects.toThrow();
    expect(
      readFileSync(path.join(f.worktree.worktreePath, "last-moment-owned-source"), "utf8"),
    ).toBe("keep");
  } finally {
    await f.close();
  }
});

test("canonical pending backing also fences a symlink alias and its not-yet-created child", async () => {
  const f = await canonicalArchiveFixture();
  f.deps.archiveWorkspaceRecord = async () => {
    throw new Error("fixture native write interrupted");
  };
  const { symlink } = await import("node:fs/promises");
  const alias = path.join(path.dirname(f.home), "backing-alias");
  try {
    expect(
      (
        await archiveByScope(f.deps, {
          scope: { kind: "workspace", workspaceId: "old-a" },
          requestId: "alias-fence",
        })
      ).retirement?.state,
    ).toBe("partial");
    await symlink(f.worktree.worktreePath, alias, "dir");
    await expect(f.registry.assertBackingWriteAllowed(alias)).rejects.toThrow(
      "retirement_backing_reserved",
    );
    await expect(
      f.registry.assertBackingWriteAllowed(path.join(alias, "future-child")),
    ).rejects.toThrow("retirement_backing_reserved");
    expect(existsSync(path.join(f.worktree.worktreePath, "future-child"))).toBe(false);
  } finally {
    await f.close();
  }
});
