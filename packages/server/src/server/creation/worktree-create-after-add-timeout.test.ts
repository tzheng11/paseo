import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CreationSnapshot, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ForgeService } from "../../services/forge-service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { getCheckoutStatus } from "../../utils/checkout-git.js";
import { createPaseoWorktree } from "../paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { createStub } from "../test-utils/class-mocks.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { CreationService } from "./index.js";

const worktreeAdd = vi.hoisted(() => ({ timeOutNext: false }));
vi.mock("../../utils/run-git-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/run-git-command.js")>();
  const runGitCommand: typeof actual.runGitCommand = async (args, options) => {
    if (worktreeAdd.timeOutNext && args[0] === "worktree" && args[1] === "add") {
      worktreeAdd.timeOutNext = false;
      throw new Error(`Git command timed out after ${options.timeout}ms: git ${args.join(" ")}`);
    }
    return actual.runGitCommand(args, options);
  };
  return { ...actual, runGitCommand };
});

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a create after an earlier git worktree add timed out reaches workspace_ready while its source checkout's refresh stays in flight", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "creation-after-add-timeout-")));
  cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
  const repoDir = path.join(tempDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");

  const paseoHome = path.join(tempDir, ".paseo");
  const logger = createTestLogger();
  // A saturated host: the source checkout's snapshot refresh starts and does not finish.
  let holdRefresh = false;
  const refreshHeld = deferred();
  const releaseRefresh = deferred();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome,
    deps: {
      getCheckoutStatus: async (cwd, context, options) => {
        if (holdRefresh && path.resolve(cwd) === repoDir) {
          refreshHeld.resolve();
          await releaseRefresh.promise;
        }
        return getCheckoutStatus(cwd, context, options);
      },
    },
  });
  cleanups.push(() => workspaceGitService.dispose());
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry: new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    ),
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async () => true,
    logger,
  });
  const creations = new CreationService(path.join(paseoHome, "creations"), logger);
  const phases = new Map<string, string[]>();
  const create = (key: string, slug: string): Promise<CreationSnapshot> =>
    creations.create(
      {
        kind: "workspace",
        key,
        request: { cwd: repoDir, slug },
        hasAgent: false,
        hasPrompt: false,
        exists: async (_kind, id) => (await workspaceRegistry.get(id)) !== null,
        provision: async (workspaceId) => {
          const created = await createPaseoWorktree(
            { cwd: repoDir, worktreeSlug: slug, workspaceId, paseoHome },
            {
              github: createStub<ForgeService>({ invalidate: () => {} }),
              workspaceGitService,
              workspaceProvisioning,
            },
          );
          return {
            workspace: workspaceDescriptor(created.workspace.workspaceId, created.workspace.cwd),
          };
        },
      },
      (snapshot) => phases.set(key, [...(phases.get(key) ?? []), snapshot.phase]),
    );

  worktreeAdd.timeOutNext = true;
  expect(await create("earlier", "earlier")).toMatchObject({
    phase: "failed",
    failedStage: "workspace",
    error: expect.stringMatching(/^Git command timed out after \d+ms: git worktree add /),
  });

  // The daemon keeps the source registered as a dormant sidebar record.
  workspaceGitService.registerWorkspace({ cwd: repoDir, observeWorkingTree: false }, () => {});
  holdRefresh = true;
  const heldRefresh = workspaceGitService
    .getSnapshot(repoDir, { force: true, reason: "busy-host" })
    .catch(() => undefined);
  cleanups.push(async () => {
    releaseRefresh.resolve();
    await heldRefresh;
  });
  await refreshHeld.promise;

  const later = await settleWithin(create("later", "later"), 10_000);
  expect(later).toMatchObject({ phase: "completed", error: null });
  expect(phases.get("later")).toEqual(["accepted", "workspace_ready", "completed"]);
  expect(await workspaceRegistry.get(later!.workspaceId!)).toMatchObject({ kind: "worktree" });
  expect(git(repoDir, "worktree", "list", "--porcelain")).toContain(
    `worktree ${later!.workspace!.workspaceDirectory}`,
  );
});

/** Resolves null instead of hanging the suite when the create never settles. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function workspaceDescriptor(id: string, workspaceDirectory: string): WorkspaceDescriptorPayload {
  return {
    id,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/project",
    workspaceDirectory,
    projectKind: "git",
    workspaceKind: "worktree",
    name: "Worktree",
    status: "running",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    scripts: [],
  };
}
