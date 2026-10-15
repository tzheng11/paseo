import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

export interface ChildPidListing {
  pids: number[];
  error: unknown;
}

// Injection seam: production lists children with pgrep (macOS) or ps (Linux); tests
// wire a lister that throws or reports a failed spawn.
export type ChildPidLister = (parentPid: number) => Promise<ChildPidListing>;

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitPromise = waitForProcessExit(child);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
  listChildPids: ChildPidLister = listChildPidsWithSpawn,
): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return signalPidTree(pid, signal, listChildPids).catch(() => {
    signalDirectChild(child, signal);
  });
}

// Signals a process and every descendant it can find. Rejects with the first listing or
// signal error, after signalling everything already found.
export async function signalPidTree(
  pid: number,
  signal: NodeJS.Signals,
  listChildPids: ChildPidLister = listChildPidsWithSpawn,
): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return;
  }
  const error = await signalKnownTree(pid, signal, listChildPids);
  if (error) {
    throw error;
  }
}

// tree-kill lists children by spawning pgrep or ps again from each child's "close"
// handler. A spawn that throws there, or emits "error" with no listener, is an uncaught
// exception: on 14 Oct 2026 spawn threw EBADF (the daemon held descriptors numbered past
// 10,240, where macOS posix_spawn rejects them) and the whole daemon crashed. This walk
// guards every listing and, if one fails, still signals every process already found.
async function signalKnownTree(
  rootPid: number,
  signal: NodeJS.Signals,
  listChildPids: ChildPidLister,
): Promise<unknown> {
  const seen = new Set<number>([rootPid]);
  const order: number[] = [];
  let level = [rootPid];
  let firstError: unknown = null;
  while (level.length > 0) {
    const listings = await Promise.all(
      level.map((parentPid) => listChildPidsSafely(listChildPids, parentPid)),
    );
    order.push(...level);
    const next: number[] = [];
    for (const listing of listings) {
      firstError = firstError ?? listing.error;
      for (const childPid of listing.pids) {
        if (!seen.has(childPid)) {
          seen.add(childPid);
          next.push(childPid);
        }
      }
    }
    level = next;
  }

  for (const targetPid of order.toReversed()) {
    try {
      process.kill(targetPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        firstError = firstError ?? error;
      }
    }
  }
  return firstError;
}

async function listChildPidsSafely(
  listChildPids: ChildPidLister,
  parentPid: number,
): Promise<ChildPidListing> {
  try {
    return await listChildPids(parentPid);
  } catch (error) {
    return { pids: [], error };
  }
}

function listChildPidsWithSpawn(parentPid: number): Promise<ChildPidListing> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (listing: ChildPidListing): void => {
      if (!settled) {
        settled = true;
        resolve(listing);
      }
    };

    let lister: ChildProcess;
    try {
      lister =
        process.platform === "darwin"
          ? spawn("pgrep", ["-P", String(parentPid)], { stdio: ["ignore", "pipe", "ignore"] })
          : spawn("ps", ["-o", "pid", "--no-headers", "--ppid", String(parentPid)], {
              stdio: ["ignore", "pipe", "ignore"],
            });
    } catch (error) {
      settle({ pids: [], error });
      return;
    }

    let output = "";
    lister.stdout?.on("data", (data: Buffer) => {
      output += data.toString("ascii");
    });
    lister.stdout?.on("error", () => undefined);
    lister.on("error", (error) => settle({ pids: [], error }));
    lister.on("close", (code) => {
      // pgrep and ps exit non-zero when the process has no children.
      if (code !== 0) {
        settle({ pids: [], error: null });
        return;
      }
      const pids = (output.match(/\d+/g) ?? [])
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      settle({ pids, error: null });
    });
  });
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
