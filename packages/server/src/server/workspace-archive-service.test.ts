import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { Session } from "./session.js";
import { retireCanonicalProject } from "./project-retirement.js";
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
  FileBackedProjectRegistry,
  createPersistedProjectRecord,
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

async function canonicalArchiveFixture(teardown?: string, activate = true) {
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
  if (activate)
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
  const order: string[] = [];
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
      stopWorkspaceSetup: async () => {
        order.push("stop-setup");
      },
      emitWorkspaceUpdatesForWorkspaceIds: f.deps.emitWorkspaceUpdatesForWorkspaceIds,
      markWorkspaceArchiving: f.deps.markWorkspaceArchiving,
      clearWorkspaceArchiving: f.deps.clearWorkspaceArchiving,
      logger,
    });
    vi.spyOn(manager, "listAgents").mockImplementation(() => {
      order.push("agents");
      return [];
    });
    const result = await catalog.executeTool("archive_workspace", { workspaceId: "old-a" });
    expect(result.isError).not.toBe(true);
    expect(order[0]).toBe("stop-setup");
    expect(order).toContain("agents");
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

test("REVIEW MCP refuses untrusted source before reservation and hooks", async () => {
  const f = await canonicalArchiveFixture(
    "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+'/review-untrusted-hook','ran')\"",
  );
  const logger = createLogger();
  const storage = new AgentStorage(path.join(f.home, "agents"), logger);
  const manager = new AgentManager({ clients: {}, registry: storage, logger });
  try {
    await f.registry.update("old-a", (r) => ({
      ...r,
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "untrusted/fork",
      },
    }));
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
    let result: Awaited<ReturnType<typeof catalog.executeTool>> | undefined;
    let rejection: unknown;
    try {
      result = await catalog.executeTool("archive_workspace", { workspaceId: "old-a" });
    } catch (error) {
      rejection = error;
    }
    const hookRan = existsSync(path.join(f.repoDir, "review-untrusted-hook"));
    expect(rejection instanceof Error || result?.isError === true).toBe(true);
    expect(hookRan).toBe(false);
    expect((await f.layout.inspect()).retirements).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("REVIEW unrelated native metadata write proceeds during paused retirement", async () => {
  const f = await canonicalArchiveFixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.deps.stopWorkspaceSetup = async () => {
    entered();
    await gate;
  };
  let archive: ReturnType<typeof archiveByScope> | undefined;
  let update: Promise<unknown> | undefined;
  let completed = false;
  try {
    await f.registry.upsert({
      ...f.record,
      workspaceId: "unrelated",
      cwd: f.repoDir,
      worktreeRoot: f.repoDir,
      kind: "local_checkout",
      isPaseoOwnedWorktree: false,
    });
    archive = archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "review-pause",
    });
    await ready;
    update = f.registry
      .update("unrelated", (r) => ({ ...r, title: "unrelated metadata change" }))
      .then((r) => {
        completed = true;
        return r;
      });
    await Promise.race([update, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    expect(completed).toBe(true);
  } finally {
    release();
    await archive;
    await update;
    await f.close();
  }
});

test("REVIEW multi-alias slot reuse rejects A whole-path generation and old-ID replay preserves B", async () => {
  const f = await canonicalArchiveFixture();
  const { nativeGeneration } = await import("./workspace-retirement.js");
  try {
    const alias = { ...f.record, workspaceId: "shared-alias" };
    await f.registry.upsert(alias);
    const staleGeneration = nativeGeneration([f.record, alias]);
    const first = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "review-old-a",
    });
    expect(first.retirement?.state).toBe("complete");
    expect(first.directoryLeftBehind?.reason).toBe("shared_backing_retained");
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T21:00:00.000Z",
    });
    mkdirSync(path.join(f.worktree.worktreePath, "node_modules"));
    writeFileSync(path.join(f.worktree.worktreePath, "node_modules", "b-service-dependency"), "B");
    const killCount = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    await expect(
      archiveByScope(f.deps, {
        scope: {
          kind: "worktree",
          targetPath: f.worktree.worktreePath,
          expectedBackingGeneration: staleGeneration,
        },
        requestId: "review-stale-path",
      }),
    ).rejects.toThrow("canonical_backing_generation_required_or_changed");
    expect(
      await archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "review-stale-id",
      }),
    ).toEqual(first);
    expect(
      readFileSync(
        path.join(f.worktree.worktreePath, "node_modules", "b-service-dependency"),
        "utf8",
      ),
    ).toBe("B");
    expect((await f.registry.get("new-b"))?.archivedAt).toBe(null);
    expect((await f.registry.get("shared-alias"))?.archivedAt).toBe(null);
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(killCount);
  } finally {
    await f.close();
  }
});

test("REVIEW failed project removal retry never archives replacement B after native completion", async () => {
  const f = await canonicalArchiveFixture();
  const messages: Array<{ type: string; payload?: unknown }> = [];
  let failRemoval = true;
  const session = Object.assign(Object.create(Session.prototype), {
    paseoHome: f.home,
    workspaceLayoutService: f.layout,
    workspaceRegistry: f.registry,
    projectRegistry: {
      get: async () => ({ projectId: "project" }),
      remove: async () => {
        if (failRemoval) {
          failRemoval = false;
          throw new Error("fixture project persistence failure");
        }
      },
    },
    readRetirementRecords: () => f.registry.listRetirementRecords(),
    workspaceArchiveDependencies: () => f.deps,
    clearWorkspaceArchiving: () => {},
    emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    sessionLogger: createLogger(),
    emit: (message: { type: string; payload?: unknown }) => messages.push(message),
  }) as {
    handleProjectRemoveRequest: (request: {
      type: "project.remove.request";
      projectId: string;
      requestId: string;
    }) => Promise<void>;
  };
  try {
    const request = {
      type: "project.remove.request" as const,
      projectId: "project",
      requestId: "same-project-removal-request",
    };
    await session.handleProjectRemoveRequest(request);
    expect(messages.at(-1)?.payload).toMatchObject({
      accepted: false,
      error: "fixture project persistence failure",
    });
    expect((await f.layout.inspect()).retirements?.[0].state).toBe("complete");
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T21:00:00.000Z",
    });
    mkdirSync(path.join(f.worktree.worktreePath, "node_modules"));
    writeFileSync(path.join(f.worktree.worktreePath, "node_modules", "b-dependency"), "B");
    const kills = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    await session.handleProjectRemoveRequest(request);
    const b = await f.registry.get("new-b");
    expect(b?.archivedAt).toBe(null);
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(kills);
  } finally {
    await f.close();
  }
});

test("REVIEW explicit-ID provider import is fenced after archive captures its agent footprint", async () => {
  const f = await canonicalArchiveFixture();
  const projects = new FileBackedProjectRegistry(
    path.join(f.home, "projects", "review-projects.json"),
    createLogger(),
  );
  await projects.initialize();
  await projects.upsert(
    createPersistedProjectRecord({
      projectId: "project",
      rootPath: f.repoDir,
      kind: "git",
      displayName: "project",
      createdAt: f.record.createdAt,
      updatedAt: f.record.updatedAt,
    }),
  );
  const provisioning = createWorkspaceProvisioningService({
    serverId: "owner",
    workspaceRegistry: f.registry,
    projectRegistry: projects,
    workspaceGitService: createNoopWorkspaceGitService(),
    isDirectory: async () => true,
    logger: createLogger(),
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let imported = false;
  f.deps.agentManager.listAgents = () =>
    imported ? ([{ id: "late-imported-agent", workspaceId: "old-a" }] as ManagedAgent[]) : [];
  f.deps.killTerminalsForWorkspace = async () => {
    entered();
    await gate;
  };
  const archive = archiveByScope(f.deps, {
    scope: { kind: "workspace", workspaceId: "old-a" },
    requestId: "review-import-race",
  });
  try {
    await ready;
    expect((await f.layout.inspect()).retirements?.[0].state).toBe("reserved");
    let rejected: unknown;
    try {
      await provisioning.runInImportWorkspace(
        { requestedWorkspaceId: "old-a", cwd: f.record.cwd },
        async () => {
          imported = true;
          return "imported";
        },
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(imported).toBe(false);
  } finally {
    release();
    const outcome = await archive;
    expect(outcome.retirement?.state).toBe("complete");
    await f.close();
  }
});

test("REVIEW importing-phase refusal permits a fresh archive after activation", async () => {
  const f = await canonicalArchiveFixture(undefined, false);
  try {
    const first = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "before-activation",
    });
    expect(first.retirement).toMatchObject({ state: "partial", code: "layout_importing" });
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    const snapshot = await f.layout.inspect();
    expect(snapshot.retirements).toBeUndefined();
    await f.layout.commit({
      writerVersion: 2,
      requestId: randomUUID(),
      expected: snapshot.stamp,
      mutations: [
        {
          kind: "activate",
          requiredImports: snapshot.imports,
          requiredOwnerDomains: snapshot.ownerDomains,
        },
      ],
    });
    const second = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "after-activation",
    });
    let backingError: unknown;
    try {
      await f.registry.assertBackingWriteAllowed(f.record.cwd);
    } catch (error) {
      backingError = error;
    }
    expect(backingError).toBeUndefined();
    expect(second.retirement?.state).toBe("complete");
  } finally {
    await f.close();
  }
});

async function projectCompletionFixture() {
  const f = await canonicalArchiveFixture();
  const file = path.join(f.home, "projects", "project-completion.json");
  const projects = new FileBackedProjectRegistry(file, createLogger());
  await projects.initialize();
  const project = createPersistedProjectRecord({
    projectId: "project",
    rootPath: f.repoDir,
    kind: "git",
    displayName: "project",
    createdAt: f.record.createdAt,
    updatedAt: f.record.updatedAt,
  });
  await projects.upsert(project);
  const input = {
    authority: f.layout,
    projectId: "project",
    requestId: "original-project-removal",
    getProject: () => projects.get("project"),
    readRecords: () => f.registry.listRetirementRecords(),
    archive: vi.fn((workspaceIds: string[], generation: string) =>
      archiveByScope(f.deps, {
        scope: {
          kind: "project",
          projectId: "project",
          workspaceIds,
          expectedBackingGeneration: generation,
        },
        requestId: "original-project-removal",
      }),
    ),
    removeProject: vi.fn(() => projects.remove("project")),
    cleanupIcon: vi.fn(async () => {}),
  };
  return { ...f, file, projects, project, input };
}

test("project completion reopens its durable intent after a pre-write failure without repeating native teardown", async () => {
  const f = await projectCompletionFixture();
  try {
    f.input.removeProject.mockRejectedValueOnce(new Error("fixture project write failed"));
    await expect(retireCanonicalProject(f.input)).rejects.toThrow("fixture project write failed");
    const kills = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    const projects = new FileBackedProjectRegistry(f.file, createLogger());
    await projects.initialize();
    const authority = new WorkspaceLayoutService(f.layout.options);
    await authority.load();
    try {
      expect(
        await retireCanonicalProject({
          ...f.input,
          authority,
          getProject: () => projects.get("project"),
          removeProject: () => projects.remove("project"),
        }),
      ).toEqual(["old-a"]);
      expect(await projects.get("project")).toBeNull();
      expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(kills);
      expect(f.input.archive).toHaveBeenCalledTimes(1);
      expect(f.input.cleanupIcon).toHaveBeenCalledTimes(1);
    } finally {
      await authority.close();
    }
  } finally {
    await f.close();
  }
});

test("project removal persisted before a notification failure is reconciled by absence, then old completed replay preserves B", async () => {
  const f = await projectCompletionFixture();
  const detach = f.projects.subscribeToMutations((mutation) => {
    if (mutation.kind === "remove") throw new Error("fixture project notification failed");
  });
  try {
    await expect(retireCanonicalProject(f.input)).rejects.toThrow(
      "fixture project notification failed",
    );
    expect(await f.projects.get("project")).toBeNull();
    expect(await retireCanonicalProject(f.input)).toEqual(["old-a"]);
    expect(f.input.removeProject).toHaveBeenCalledTimes(1);
    expect(f.input.cleanupIcon).not.toHaveBeenCalled();
    detach();
    await f.projects.upsert({ ...f.project, createdAt: "2026-11-20T00:00:00.000Z" });
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-20T00:00:00.000Z",
    });
    const kills = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    expect(await retireCanonicalProject(f.input)).toEqual(["old-a"]);
    expect((await f.registry.get("new-b"))?.archivedAt).toBeNull();
    expect(await f.projects.get("project")).not.toBeNull();
    expect(f.input.removeProject).toHaveBeenCalledTimes(1);
    expect(f.input.cleanupIcon).not.toHaveBeenCalled();
    expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(kills);
  } finally {
    detach();
    await f.close();
  }
});

test.each(["archive-known", "native-complete"])(
  "project journal failure at %s resolves only its saved native operation",
  async (stage) => {
    const f = await projectCompletionFixture();
    const original = atomicFile.writeFileDurably;
    const writer = vi
      .spyOn(atomicFile, "writeFileDurably")
      .mockImplementation(async (file, bytes) => {
        if (file.startsWith(path.join(f.home, "project-retirements"))) {
          const journal = JSON.parse(bytes) as { phase: string; archive: unknown };
          if (
            (stage === "archive-known" && journal.archive !== null) ||
            (stage === "native-complete" && journal.phase === "native-complete")
          )
            throw new Error("fixture project journal interrupted");
        }
        return original(file, bytes);
      });
    try {
      await expect(retireCanonicalProject(f.input)).rejects.toThrow(
        "fixture project journal interrupted",
      );
      expect((await f.layout.inspect()).retirements![0].state).toBe("complete");
      const kills = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
      writer.mockRestore();
      expect(await retireCanonicalProject(f.input)).toEqual(["old-a"]);
      expect(vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length).toBe(kills);
      expect((await f.layout.inspect()).retirements).toHaveLength(1);
    } finally {
      writer.mockRestore();
      await f.close();
    }
  },
);

test("initial project intent persistence failure has zero native retirement effects", async () => {
  const f = await projectCompletionFixture();
  const original = atomicFile.writeFileDurably;
  const writer = vi
    .spyOn(atomicFile, "writeFileDurably")
    .mockImplementation(async (file, bytes) => {
      if (file.startsWith(path.join(f.home, "project-retirements")))
        throw new Error("fixture no project journal space");
      return original(file, bytes);
    });
  try {
    await expect(retireCanonicalProject(f.input)).rejects.toThrow(
      "fixture no project journal space",
    );
    expect(f.input.archive).not.toHaveBeenCalled();
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect((await f.layout.inspect()).retirements).toBeUndefined();
  } finally {
    writer.mockRestore();
    await f.close();
  }
});

test("an incomplete project request cannot consume a new project incarnation", async () => {
  const f = await projectCompletionFixture();
  try {
    f.input.removeProject.mockRejectedValueOnce(
      new Error("fixture failed before metadata removal"),
    );
    await expect(retireCanonicalProject(f.input)).rejects.toThrow(
      "fixture failed before metadata removal",
    );
    await f.projects.upsert({ ...f.project, createdAt: "2026-11-20T00:00:00.000Z" });
    await expect(retireCanonicalProject(f.input)).rejects.toThrow("project_incarnation_changed");
    expect(f.input.removeProject).toHaveBeenCalledTimes(1);
    expect(f.input.cleanupIcon).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("unrelated directory creation completes while a retirement is paused", async () => {
  const f = await projectCompletionFixture();
  let release = () => {},
    entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.deps.stopWorkspaceSetup = async () => {
    entered();
    await gate;
  };
  const provisioning = createWorkspaceProvisioningService({
    paseoHome: f.home,
    serverId: "owner",
    workspaceRegistry: f.registry,
    projectRegistry: f.projects,
    workspaceGitService: createNoopWorkspaceGitService(),
    isDirectory: async () => true,
    logger: createLogger(),
  });
  const retiring = archiveByScope(f.deps, {
    scope: { kind: "workspace", workspaceId: "old-a" },
    requestId: "paused-for-independent-create",
  });
  await ready;
  let completed = false;
  const created = provisioning
    .createWorkspaceForDirectory(f.repoDir, "independent", "project")
    .then((workspace) => {
      completed = true;
      return workspace;
    });
  try {
    await vi.waitFor(() => expect(completed).toBe(true));
    const workspace = await created;
    expect(workspace.workspaceId).not.toBe("old-a");
    expect(workspace.archivedAt).toBeNull();
  } finally {
    release();
    await Promise.all([retiring, created]);
    await f.close();
  }
});

test("an import admitted before retirement remains in its captured agent footprint", async () => {
  const f = await projectCompletionFixture();
  let release = () => {},
    entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let imported = false;
  const agent = { id: "imported-before-retirement", workspaceId: "old-a" } as ManagedAgent;
  f.deps.agentManager.listAgents = () => (imported ? [agent] : []);
  f.deps.agentManager.getAgent = () => (imported ? agent : null);
  f.deps.agentManager.archiveAgent = vi.fn(async () => {
    imported = false;
    return { archivedAt: new Date().toISOString() };
  });
  const provisioning = createWorkspaceProvisioningService({
    paseoHome: f.home,
    serverId: "owner",
    workspaceRegistry: f.registry,
    projectRegistry: f.projects,
    workspaceGitService: createNoopWorkspaceGitService(),
    isDirectory: async () => true,
    logger: createLogger(),
  });
  const importing = provisioning.runInImportWorkspace(
    { requestedWorkspaceId: "old-a", cwd: f.record.cwd },
    async () => {
      entered();
      await gate;
      imported = true;
      return "imported";
    },
  );
  await ready;
  const retiring = archiveByScope(f.deps, {
    scope: { kind: "workspace", workspaceId: "old-a" },
    requestId: "after-import-admission",
  });
  try {
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    release();
    await importing;
    const result = await retiring;
    expect(result.retirement?.state).toBe("complete");
    expect(result.removedDirectory).toBe(true);
    expect(imported).toBe(false);
    expect(f.deps.agentManager.archiveAgent).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.all([importing, retiring]);
    await f.close();
  }
});

test("a verified importing refusal also releases backing admission after activation", async () => {
  const f = await canonicalArchiveFixture(undefined, false);
  try {
    const first = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "importing-refusal",
    });
    expect(first.retirement).toMatchObject({ state: "partial", code: "layout_importing" });
    const snapshot = await f.layout.inspect();
    await f.layout.commit({
      writerVersion: 2,
      requestId: randomUUID(),
      expected: snapshot.stamp,
      mutations: [
        {
          kind: "activate",
          requiredImports: snapshot.imports,
          requiredOwnerDomains: snapshot.ownerDomains,
        },
      ],
    });
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-alias-after-refusal",
      createdAt: "2026-11-20T00:00:00.000Z",
    });
    const second = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "archive-after-activation",
    });
    expect(second.retirement?.state).toBe("complete");
    expect(second.retirement?.operationId).not.toBe(first.retirement?.operationId);
    expect(second.directoryLeftBehind?.reason).toBe("shared_backing_retained");
    expect((await f.registry.get("new-alias-after-refusal"))?.archivedAt).toBeNull();
  } finally {
    await f.close();
  }
});

test("a project movement before reservation refuses the saved project footprint before effects", async () => {
  const f = await projectCompletionFixture();
  const original = f.input.archive;
  f.input.archive = vi.fn(async (ids: string[], generation: string) => {
    const snapshot = await f.layout.inspect();
    await f.layout.commit({
      writerVersion: 2,
      requestId: randomUUID(),
      expected: snapshot.stamp,
      mutations: [
        { kind: "put", entry: { ...snapshot.entries[0], projectId: "different-project" } },
      ],
    });
    return original(ids, generation);
  });
  try {
    await expect(retireCanonicalProject(f.input)).rejects.toThrow(
      "Project retirement remains fenced pending reconciliation",
    );
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect((await f.layout.inspect()).retirements).toBeUndefined();
    expect(f.input.removeProject).not.toHaveBeenCalled();
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});

test("caller operation ID survives canonical archive and an exact replay", async () => {
  const f = await canonicalArchiveFixture();
  const operationId = randomUUID();
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "caller-first",
    operationId,
  };
  try {
    const first = await archiveByScope(f.deps, request);
    expect(first.retirement).toMatchObject({ operationId, state: "complete" });
    expect(await archiveByScope(f.deps, { ...request, requestId: "caller-lost-reply" })).toEqual(
      first,
    );
  } finally {
    await f.close();
  }
});

test("caller operation records a native hold before effects and lookup never starts it", async () => {
  const f = await canonicalArchiveFixture();
  const operationId = randomUUID();
  try {
    vi.spyOn(f.deps.agentManager, "listAgents");
    f.deps.assertWorkspaceAutomationAllowed = async () => {
      throw new Error("retirement_native_hold");
    };
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "caller-hold",
        operationId,
      } as Parameters<typeof archiveByScope>[1]),
    ).rejects.toThrow("retirement_native_hold");
    const api = (await import("./workspace-retirement.js")) as unknown as {
      getWorkspaceRetirementStatus: (authority: typeof f.layout, id: string) => Promise<unknown>;
    };
    expect(typeof api.getWorkspaceRetirementStatus).toBe("function");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      operationId,
      workspaceId: "old-a",
      state: "refused",
      terminal: true,
    });
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
    expect(f.deps.agentManager.listAgents).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("canonical synchronous teardown receives caller operation and backing generation", async () => {
  const f = await canonicalArchiveFixture(
    'node -e \'require("node:fs").writeFileSync(process.env.PASEO_WORKTREE_PATH + ".binding", JSON.stringify({operationId:process.env.PASEO_RETIREMENT_OPERATION_ID,backingGeneration:process.env.PASEO_RETIREMENT_BACKING_GENERATION,workspaceId:process.env.PASEO_RETIREMENT_WORKSPACE_ID,worktreePath:process.env.PASEO_RETIREMENT_WORKTREE_PATH,teardownCwd:process.env.PASEO_RETIREMENT_TEARDOWN_CWD}))\'',
  );
  const operationId = randomUUID();
  try {
    await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "caller-hook",
      operationId,
    } as Parameters<typeof archiveByScope>[1]);
    expect(JSON.parse(readFileSync(f.worktree.worktreePath + ".binding", "utf8"))).toEqual({
      operationId,
      backingGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspaceId: "old-a",
      worktreePath: f.worktree.worktreePath,
      teardownCwd: f.worktree.worktreePath,
    });
  } finally {
    await f.close();
  }
});

test("caller UUID conflicts, pure readback, partial state and restart retain the original operation", async () => {
  const f = await canonicalArchiveFixture();
  const { getWorkspaceRetirementStatus } = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "partial-first",
    operationId,
  };
  try {
    f.deps.killTerminalsForWorkspace = vi.fn(async () => {
      throw new Error("fixture terminal failure");
    });
    const result = await archiveByScope(f.deps, request);
    expect(result.retirement).toMatchObject({ operationId, state: "partial" });
    const before = readFileSync(path.join(f.home, "workspace-layout.json"), "utf8");
    const status = await getWorkspaceRetirementStatus(f.layout, operationId);
    expect(status).toMatchObject({ operationId, state: "partial", terminal: false, result });
    expect(await getWorkspaceRetirementStatus(f.layout, randomUUID())).toBeNull();
    expect(await archiveByScope(f.deps, { ...request, requestId: "lost-reply" })).toEqual(result);
    expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(1);
    await expect(
      archiveByScope(f.deps, { ...request, scope: { kind: "workspace", workspaceId: "new-b" } }),
    ).rejects.toThrow("retirement_operation_id_conflict");
    const reopened = new WorkspaceLayoutService(f.layout.options);
    try {
      expect(await getWorkspaceRetirementStatus(reopened, operationId)).toEqual(status);
    } finally {
      await reopened.close();
    }
    expect(readFileSync(path.join(f.home, "workspace-layout.json"), "utf8")).toBe(before);
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});

test("caller hold UUID stays terminal after the hold clears; a fresh UUID may proceed", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "hold",
    operationId,
  };
  try {
    f.deps.assertWorkspaceAutomationAllowed = async () => {
      throw new Error("retirement_native_hold");
    };
    await expect(archiveByScope(f.deps, request)).rejects.toThrow("retirement_native_hold");
    const held = await api.getWorkspaceRetirementStatus(f.layout, operationId);
    expect(held).toMatchObject({
      state: "refused",
      code: "retirement_native_hold",
      terminal: true,
      result: null,
    });
    f.deps.assertWorkspaceAutomationAllowed = async () => {};
    await expect(archiveByScope(f.deps, request)).rejects.toThrow("retirement_native_hold");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toEqual(held);
    const fresh = await archiveByScope(f.deps, { ...request, operationId: randomUUID() });
    expect(fresh.retirement?.state).toBe("complete");
    expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test("caller readback during a lost reply is pending and never retries the paused operation", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operationId = randomUUID();
  f.deps.stopWorkspaceSetup = vi.fn(async () => {
    started();
    await gate;
  });
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "timeout",
    operationId,
  };
  const running = archiveByScope(f.deps, request);
  try {
    await entered;
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "pending",
      terminal: false,
      operationId,
    });
    expect(
      (await archiveByScope(f.deps, { ...request, requestId: "duplicate" })).retirement,
    ).toMatchObject({ operationId, state: "partial", code: "retirement_in_progress" });
    expect(f.deps.stopWorkspaceSetup).toHaveBeenCalledTimes(1);
    release();
    const result = await running;
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "complete",
      terminal: true,
      result,
    });
    await expect(archiveByScope(f.deps, { ...request, operationId: randomUUID() })).rejects.toThrow(
      "retirement_operation_id_conflict",
    );
  } finally {
    release();
    await running;
    await f.close();
  }
});

test("live synchronous hook verification expires before kept A's slot becomes B", async () => {
  const f = await canonicalArchiveFixture(
    'node -e \'const fs=require("node:fs");const p=process.env.PASEO_WORKTREE_PATH;fs.writeFileSync(p+".binding",JSON.stringify({operationId:process.env.PASEO_RETIREMENT_OPERATION_ID,backingGeneration:process.env.PASEO_RETIREMENT_BACKING_GENERATION,workspaceId:process.env.PASEO_RETIREMENT_WORKSPACE_ID,worktreePath:process.env.PASEO_RETIREMENT_WORKTREE_PATH,teardownCwd:process.env.PASEO_RETIREMENT_TEARDOWN_CWD}));const t=setInterval(()=>{if(fs.existsSync(p+".release")){fs.writeFileSync(p+"/keep-source","owned");clearInterval(t)}},25)\'',
  );
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  const running = archiveByScope(f.deps, {
    scope: { kind: "workspace", workspaceId: "old-a" },
    operationId,
    requestId: "hook-verify",
  });
  try {
    await vi.waitFor(() => expect(existsSync(f.worktree.worktreePath + ".binding")).toBe(true), {
      timeout: 10000,
    });
    const binding = JSON.parse(readFileSync(f.worktree.worktreePath + ".binding", "utf8"));
    expect(await api.verifyWorkspaceRetirementBinding(f.home, binding)).toEqual({
      valid: true,
      code: null,
    });
    for (const changed of [
      { operationId: randomUUID() },
      { workspaceId: "new-b" },
      { backingGeneration: "f".repeat(64) },
      { worktreePath: path.dirname(binding.worktreePath) },
      { teardownCwd: binding.teardownCwd + "/nested" },
    ])
      expect(
        (await api.verifyWorkspaceRetirementBinding(f.home, { ...binding, ...changed })).valid,
      ).toBe(false);
    expect(
      (await api.verifyWorkspaceRetirementBinding(path.join(f.home, "other"), binding)).valid,
    ).toBe(false);
    writeFileSync(f.worktree.worktreePath + ".release", "release");
    const result = await running;
    expect(result).toMatchObject({
      slotKept: true,
      removedDirectory: false,
      directoryLeftBehind: { reason: "source_changed_before_removal" },
    });
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      createdAt: "2026-11-19T23:00:00.000Z",
      updatedAt: "2026-11-19T23:00:00.000Z",
    });
    const sentinel = path.join(f.worktree.worktreePath, "b-dependencies");
    writeFileSync(sentinel, "B");
    const before = await f.registry.get("new-b");
    expect(await api.verifyWorkspaceRetirementBinding(f.home, binding)).toEqual({
      valid: false,
      code: "retirement_hook_not_active",
    });
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "complete",
      result,
    });
    expect(await f.registry.get("new-b")).toEqual(before);
    expect(readFileSync(sentinel, "utf8")).toBe("B");
  } finally {
    writeFileSync(f.worktree.worktreePath + ".release", "release");
    await running;
    await f.close();
  }
});

test("caller operation intent persistence failure produces zero teardown effects", async () => {
  const f = await canonicalArchiveFixture();
  const original = atomicFile.writeFileDurably;
  const write = vi.spyOn(atomicFile, "writeFileDurably").mockImplementation((file, bytes) => {
    if (file.includes("workspace-retirement-operations"))
      return Promise.reject(new Error("fixture disk failure"));
    return original(file, bytes);
  });
  try {
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "disk-failure",
        operationId: randomUUID(),
      }),
    ).rejects.toThrow("fixture disk failure");
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect((await f.layout.inspect()).retirements ?? []).toHaveLength(0);
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    write.mockRestore();
    await f.close();
  }
});
test("a failed synchronous hook has durable partial evidence and no live verification permit", async () => {
  const f = await canonicalArchiveFixture(
    'node -e \'require("fs").writeFileSync(process.env.PASEO_WORKTREE_PATH+".binding",JSON.stringify({operationId:process.env.PASEO_RETIREMENT_OPERATION_ID,backingGeneration:process.env.PASEO_RETIREMENT_BACKING_GENERATION,workspaceId:process.env.PASEO_RETIREMENT_WORKSPACE_ID,worktreePath:process.env.PASEO_RETIREMENT_WORKTREE_PATH,teardownCwd:process.env.PASEO_RETIREMENT_TEARDOWN_CWD}));process.exit(7)\'',
  );
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  try {
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "hook-failed",
      operationId,
    });
    expect(result.retirement?.state).toBe("partial");
    const binding = JSON.parse(readFileSync(f.worktree.worktreePath + ".binding", "utf8"));
    expect(await api.verifyWorkspaceRetirementBinding(f.home, binding)).toEqual({
      valid: false,
      code: "retirement_hook_not_active",
    });
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "partial",
      result,
    });
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    await f.close();
  }
});
test("an old implicit operation UUID cannot fence an unrelated new target", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  try {
    writeFileSync(path.join(f.worktree.worktreePath, "retain-a"), "A");
    const original = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "implicit-a",
    });
    const operationId = original.retirement!.operationId;
    const other = path.join(f.repoDir, "other-b");
    mkdirSync(other);
    await f.registry.upsert({
      ...f.record,
      workspaceId: "new-b",
      kind: "directory",
      cwd: other,
      worktreeRoot: null,
      mainRepoRoot: null,
      isPaseoOwnedWorktree: false,
      createdAt: "2026-11-19T23:00:00.000Z",
      updatedAt: "2026-11-19T23:00:00.000Z",
    });
    const killed = vi.mocked(f.deps.killTerminalsForWorkspace).mock.calls.length;
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "new-b" },
        operationId,
        requestId: "conflicting-b",
      }),
    ).rejects.toThrow("retirement_operation_id_conflict");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      workspaceId: "old-a",
      state: "complete",
      result: original,
    });
    expect((await f.registry.get("new-b"))?.archivedAt).toBeNull();
    expect(f.deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(killed);
    await f.registry.update("new-b", (record) => ({ ...record, title: "still-admissible" }));
    expect((await f.registry.get("new-b"))?.title).toBe("still-admissible");
  } finally {
    await f.close();
  }
});

test("caller status is a pure read even with every durable write and commit forbidden", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  try {
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "read-only",
      operationId,
    });
    const write = vi
      .spyOn(atomicFile, "writeFileDurably")
      .mockRejectedValue(new Error("READ_ONLY_WRITE_FORBIDDEN"));
    const commit = vi
      .spyOn(f.layout, "commit")
      .mockRejectedValue(new Error("READ_ONLY_COMMIT_FORBIDDEN"));
    try {
      expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
        state: "complete",
        result,
      });
      expect(await api.getWorkspaceRetirementStatus(f.layout, randomUUID())).toBeNull();
      expect(write).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      commit.mockRestore();
    }
  } finally {
    await f.close();
  }
});
test("restart with only a durable pending caller intent never restarts an uncertain archive", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  let indexWrites = 0;
  const original = atomicFile.writeFileDurably;
  const write = vi.spyOn(atomicFile, "writeFileDurably").mockImplementation((file, bytes) => {
    if (file.includes("workspace-retirement-operations") && ++indexWrites > 2)
      return Promise.reject(new Error("fixture outcome unavailable"));
    if (file.includes("workspace-retirements"))
      return Promise.reject(new Error("fixture cut before journal"));
    return original(file, bytes);
  });
  const request = {
    scope: { kind: "workspace" as const, workspaceId: "old-a" },
    requestId: "cut",
    operationId,
  };
  try {
    await expect(archiveByScope(f.deps, request)).rejects.toThrow("fixture outcome unavailable");
    write.mockRestore();
    const reopened = new WorkspaceLayoutService(f.layout.options);
    try {
      expect(await api.getWorkspaceRetirementStatus(reopened, operationId)).toMatchObject({
        state: "partial",
        terminal: false,
        code: "retirement_reconciliation_required",
        result: null,
      });
    } finally {
      await reopened.close();
    }
    expect(
      (await archiveByScope(f.deps, { ...request, requestId: "after-restart" })).retirement,
    ).toMatchObject({ operationId, state: "partial", code: "retirement_reconciliation_required" });
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
  } finally {
    write.mockRestore();
    await f.close();
  }
});
test("MCP preserves caller UUID and scope-checks read-only status", async () => {
  const f = await canonicalArchiveFixture();
  const logger = createLogger();
  const storage = new AgentStorage(path.join(f.home, "agents"), logger);
  const manager = new AgentManager({ clients: {}, registry: storage, logger });
  try {
    const options = {
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
    };
    const catalog = createPaseoToolCatalog(options);
    const operationId = randomUUID();
    const result = await catalog.executeTool("archive_workspace", {
      workspaceId: "old-a",
      operationId,
    });
    expect(result.structuredContent).toMatchObject({
      retirement: { operationId, state: "complete" },
    });
    expect(
      (await catalog.executeTool("get_workspace_retirement_status", { operationId }))
        .structuredContent,
    ).toMatchObject({ operation: { workspaceId: "old-a", state: "complete", operationId } });
    const scoped = createPaseoToolCatalog({
      ...options,
      callerAgentId: "scoped",
      resolveCallerContext: () => ({ lockedCwd: path.join(f.repoDir, "outside") }),
    });
    await expect(
      scoped.executeTool("get_workspace_retirement_status", { operationId }),
    ).rejects.toThrow("outside the caller scope");
  } finally {
    await f.close();
  }
});
test("caller untrusted-source refusal is recorded as a typed hold before reservation", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  try {
    await f.registry.update("old-a", (r) => ({
      ...r,
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 1,
        headRepository: "fixture/untrusted",
      },
    }));
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "untrusted",
        operationId,
      }),
    ).rejects.toThrow("Scripts are blocked");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "refused",
      terminal: true,
      code: "workspace_automation_blocked",
    });
    expect((await f.layout.inspect()).retirements ?? []).toHaveLength(0);
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test("a caller ID lookup rejects a copied record for another operation", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  try {
    await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "bound-index",
      operationId,
    });
    const other = randomUUID();
    const folder = path.join(f.home, "workspace-retirement-operations");
    writeFileSync(
      path.join(folder, `${other}.json`),
      readFileSync(path.join(folder, `${operationId}.json`)),
    );
    await expect(api.getWorkspaceRetirementStatus(f.layout, other)).rejects.toThrow(
      "retirement_operation_binding_changed",
    );
  } finally {
    await f.close();
  }
});
test("caller admission binds native generation before resolving the effect footprint", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  const get = f.deps.getWorkspace!;
  let reads = 0;
  const movedCwd = path.join(f.worktree.worktreePath, "moved-cwd");
  mkdirSync(movedCwd);
  f.deps.getWorkspace = async (id) => {
    const record = await get(id);
    if (++reads === 1) await f.registry.update(id, (r) => ({ ...r, cwd: movedCwd }));
    return record;
  };
  try {
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "native-race",
        operationId,
      }),
    ).rejects.toThrow("retirement_operation_generation_changed");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "refused",
      terminal: true,
      code: "retirement_operation_generation_changed",
    });
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    expect(existsSync(f.worktree.worktreePath)).toBe(true);
    expect((await f.layout.inspect()).retirements ?? []).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("REV69 explicit-ID contention waits without burning the caller UUID", async () => {
  const f = await canonicalArchiveFixture();
  const { serializeWorkspaceBacking } = await import("./workspace-retirement-context.js");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const holder = serializeWorkspaceBacking(f.worktree.worktreePath, async () => {
    entered();
    await gate;
  });
  const operationId = randomUUID();
  let settled = false;
  let pending: Promise<{ result?: ArchiveResult; error?: unknown }> | undefined;
  try {
    await ready;
    pending = archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "contended",
      operationId,
    }).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await new Promise<void>((r) => setTimeout(r, 75));
    expect(settled).toBe(false);
    release();
    await holder;
    const outcome = await pending;
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.retirement).toMatchObject({ operationId, state: "complete" });
    expect(
      await archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "contended-replay",
        operationId,
      }),
    ).toEqual(outcome.result);
  } finally {
    release();
    await holder;
    await pending;
    await f.close();
  }
});
test("REV69 completed journal with a pending caller index has no reconciliation code", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const operationId = randomUUID();
  try {
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "completion-gap",
      operationId,
    });
    const file = path.join(f.home, "workspace-retirement-operations", `${operationId}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        state: "pending",
        terminal: false,
        result: null,
        backingGeneration: null,
        code: null,
      }),
    );
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "complete",
      terminal: true,
      code: null,
      result,
    });
  } finally {
    await f.close();
  }
});
test("REV69 unrelated invalid journal names do not poison unknown-ID lookup", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  try {
    const dir = path.join(f.home, "workspace-retirements");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "deadbeef.json"), "{not json");
    expect(await api.getWorkspaceRetirementStatus(f.layout, randomUUID())).toBeNull();
  } finally {
    await f.close();
  }
});
test("REV69 canonical hook receives its owner home over an inherited different home", async () => {
  const f = await canonicalArchiveFixture(
    'node -e \'require("fs").writeFileSync(process.env.PASEO_WORKTREE_PATH+".home",process.env.PASEO_HOME||"")\'',
  );
  const previous = process.env.PASEO_HOME;
  try {
    process.env.PASEO_HOME = f.home + "-wrong";
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "owner-home",
    });
    expect(result.retirement?.state).toBe("complete");
    expect(readFileSync(f.worktree.worktreePath + ".home", "utf8")).toBe(f.home);
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await f.close();
  }
});
test("REV69 no-ID nested legacy worktree record retains base teardown and removal", async () => {
  const f = await canonicalArchiveFixture(
    'node -e \'require("fs").writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+"/legacy-hook-ran","yes")\'',
  );
  try {
    const nested = "legacy/nested";
    mkdirSync(path.join(f.repoDir, nested), { recursive: true });
    writeFileSync(
      path.join(f.repoDir, nested, "paseo.json"),
      readFileSync(path.join(f.repoDir, "paseo.json")),
    );
    execFileSync("git", ["add", nested], { cwd: f.repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "nested fixture config"], {
      cwd: f.repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["merge", "--ff-only", "main"], {
      cwd: f.worktree.worktreePath,
      stdio: "pipe",
    });
    await f.registry.update("old-a", (r) => ({
      ...r,
      cwd: path.join(f.worktree.worktreePath, nested),
      worktreeRoot: null,
    }));
    const result = await archiveByScope(f.deps, {
      scope: { kind: "workspace", workspaceId: "old-a" },
      requestId: "legacy-nested-no-id",
    });
    expect(result.retirement?.state).toBe("complete");
    expect(result.removedDirectory).toBe(true);
    expect(readFileSync(path.join(f.repoDir, "legacy-hook-ran"), "utf8")).toBe("yes");
    expect(existsSync(f.worktree.worktreePath)).toBe(false);
  } finally {
    await f.close();
  }
});
test("REV69 remaining scope-extension contention is typed transient rather than a hold", async () => {
  const f = await canonicalArchiveFixture();
  const { serializeWorkspaceBacking } = await import("./workspace-retirement-context.js");
  const api = await import("./workspace-retirement.js");
  const other = path.join(f.repoDir, "separate-backing");
  mkdirSync(other);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const holder = serializeWorkspaceBacking(other, async () => {
    entered();
    await gate;
  });
  const operationId = randomUUID();
  try {
    await ready;
    f.deps.assertWorkspaceAutomationAllowed = () =>
      serializeWorkspaceBacking(other, async () => {});
    await expect(
      archiveByScope(f.deps, {
        scope: { kind: "workspace", workspaceId: "old-a" },
        requestId: "dynamic-scope",
        operationId,
      }),
    ).rejects.toThrow("retirement_admission_contended");
    expect(await api.getWorkspaceRetirementStatus(f.layout, operationId)).toMatchObject({
      state: "refused",
      terminal: true,
      code: "retirement_admission_contended",
    });
    expect(f.deps.killTerminalsForWorkspace).not.toHaveBeenCalled();
    release();
    await holder;
    f.deps.assertWorkspaceAutomationAllowed = async () => {};
    expect(
      (
        await archiveByScope(f.deps, {
          scope: { kind: "workspace", workspaceId: "old-a" },
          requestId: "fresh-after-contention",
          operationId: randomUUID(),
        })
      ).retirement?.state,
    ).toBe("complete");
  } finally {
    release();
    await holder;
    await f.close();
  }
});
test("REV69 fallback skips an explicitly different ID but preserves matching corruption", async () => {
  const f = await canonicalArchiveFixture();
  const api = await import("./workspace-retirement.js");
  const id = randomUUID();
  const dir = path.join(f.home, "workspace-retirements");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "a".repeat(64) + ".json");
  try {
    writeFileSync(
      file,
      JSON.stringify({ operationId: randomUUID(), unrelatedInvalidSchema: true }),
    );
    expect(await api.getWorkspaceRetirementStatus(f.layout, id)).toBeNull();
    writeFileSync(file, JSON.stringify({ operationId: id, broken: true }));
    await expect(api.getWorkspaceRetirementStatus(f.layout, id)).rejects.toMatchObject({
      code: "retirement_lookup_integrity_failed",
    });
    writeFileSync(file, "{not json");
    await expect(api.getWorkspaceRetirementStatus(f.layout, id)).rejects.toMatchObject({
      code: "retirement_lookup_integrity_failed",
    });
  } finally {
    await f.close();
  }
});
