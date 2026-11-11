import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];
const spawnedPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-fsmonitor-"));
  tempDirs.push(repo);
  return repo;
}

async function configureFsmonitor(repo: string): Promise<string> {
  const hookPath = path.join(repo, "fsmonitor-hook.sh");
  const markerPath = `${hookPath}.marker`;
  writeFileSync(hookPath, "#!/bin/sh\n: > \"$0.marker\"\nprintf '1\\n'\n");
  chmodSync(hookPath, 0o755);
  await runGitCommand(["config", "core.fsmonitor", hookPath], { cwd: repo });
  return markerPath;
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand fsmonitor isolation", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const markerPath = await configureFsmonitor(repo);

    await runGitCommand(["status", "--porcelain"], { cwd: repo });

    expect(existsSync(markerPath)).toBe(false);
  });

  it("overrides core.fsmonitor for commands other than status", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    await configureFsmonitor(repo);

    const result = await runGitCommand(["config", "--get", "core.fsmonitor"], { cwd: repo });

    expect(result.stdout.trim()).toBe("false");
  });
});

describe("runGitCommand timeouts", () => {
  it("kills processes git started when the command times out", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    // Like `worktree add` and its checkout, the command's real work runs in a git child.
    const pidPath = path.join(repo, "helper.pid");
    const helperPath = path.join(repo, "helper.sh");
    writeFileSync(helperPath, `#!/bin/sh\nsleep 30 &\necho $! > "${pidPath}"\nwait\n`);
    chmodSync(helperPath, 0o755);

    await expect(
      runGitCommand(["-c", `alias.hold=!${helperPath}`, "hold"], { cwd: repo, timeout: 1_000 }),
    ).rejects.toThrow("Git command timed out after 1000ms");

    const helperPid = Number(readFileSync(pidPath, "utf8").trim());
    spawnedPids.push(helperPid);
    await vi.waitFor(() => expect(isAlive(helperPid)).toBe(false), { timeout: 2_000 });
  });
});
