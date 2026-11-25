import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const paseoHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live desktop heartbeat lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-live-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live legacy desktop lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(paseoHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-rewrite-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(paseoHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("starts over an empty lock file left by a supervisor killed before writing it", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await expect(getPidLockInfo(paseoHome)).resolves.toBeNull();
      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a lock file whose contents cannot be read as a lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-unparseable-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(pidPath, JSON.stringify({ pid: "unknown" }));

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Cannot read daemon state");

      await expect(readFile(pidPath, "utf-8")).resolves.toBe(JSON.stringify({ pid: "unknown" }));
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

// The clock/commands are owned fixtures: no live PID or daemon is inspected.
describe("pid-lock boot identity across sleep", () => {
  const startedAt = "2026-11-24T17:21:39.750Z";
  const wakeTime = new Date("2026-11-25T03:58:46.000Z");
  const bootId = "c6065930-45d4-4bd6-b2b2-813a470f4c87";
  const pid = 424242;
  const lock = (boot?: string) => ({
    pid,
    startedAt,
    hostname: "fixture-host",
    uid: 501,
    listen: "127.0.0.1:6767",
    ...(boot ? { bootId: boot } : {}),
  });
  async function fixture(platform: NodeJS.Platform = "darwin") {
    vi.resetModules();
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wakeTime);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const exec = vi.fn((file: string, args: readonly string[]) => {
      if (file === "/usr/sbin/sysctl") {
        expect(args).toEqual(["-n", "kern.bootsessionuuid"]);
        return bootId + "\n";
      }
      expect(file).toBe("/bin/ps");
      expect(args).toEqual(["-p", String(pid), "-o", "lstart="]);
      return "Tue Nov 24 17:21:39 2026\n";
    });
    const readBootId = vi.fn(() => "linux-boot-fixture\n");
    vi.doMock("node:child_process", async (load) => ({
      ...(await load<typeof import("node:child_process")>()),
      execFileSync: exec,
    }));
    vi.doMock("node:os", async (load) => ({
      ...(await load<typeof import("node:os")>()),
      // Awake time puts the inferred boot at 02:38:08Z, after the live lock.
      uptime: () => 4838,
    }));
    vi.doMock("node:fs", async (load) => ({
      ...(await load<typeof import("node:fs")>()),
      readFileSync: readBootId,
    }));
    vi.doMock("./host-name.js", () => ({ getHostName: () => "fixture-host" }));
    return { module: await import("./pid-lock.js"), exec, kill, readBootId };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const name of ["node:child_process", "node:os", "node:fs", "./host-name.js"])
      vi.doUnmock(name);
    vi.resetModules();
  });

  test("Darwin records and caches the boot session UUID on new locks", async () => {
    const f = await fixture();
    const home = await mkdtemp(join(tmpdir(), "paseo-darwin-boot-id-"));
    try {
      await f.module.acquirePidLock(home, null, { ownerPid: pid });
      expect(await f.module.getPidLockInfo(home)).toMatchObject({ pid, bootId });
      expect(f.module.currentBootId()).toBe(bootId);
      expect(f.exec).toHaveBeenCalledTimes(1);
      expect(f.readBootId).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("Darwin same-boot UUID keeps a live lock across the shifted boot instant", async () => {
    const f = await fixture();
    expect(f.module.writtenDuringThisBoot(lock(bootId))).toBe(true);
    expect(f.module.isPidLockOwnerRunning(lock(bootId))).toBe(true);
    expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
  });

  test("Darwin an earlier boot UUID is abandoned even when the PID is alive", async () => {
    const f = await fixture();
    expect(f.module.isPidLockOwnerRunning(lock("another-boot"))).toBe(false);
    expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
  });

  const ambiguousOwners = [
    {
      name: "same-second reused PID (17:21:39.900 vs lock .100)",
      birth: "Tue Nov 24 17:21:39 2026",
    },
    { name: "prior-boot PID born before wall-clock correction", birth: "Tue Nov 24 17:19:00 2026" },
    { name: "later-second PID", birth: "Tue Nov 24 17:21:40 2026" },
    { name: "later-boot PID", birth: "Wed Nov 25 02:38:09 2026" },
  ];
  test.each(ambiguousOwners)("Darwin legacy ownership stays unknown: $name", async ({ birth }) => {
    const f = await fixture();
    f.exec.mockImplementation((file) => (file === "/usr/sbin/sysctl" ? bootId : birth + "\n"));
    const home = await mkdtemp(join(tmpdir(), "paseo-darwin-legacy-uncertain-"));
    try {
      const bytes = JSON.stringify({ ...lock(), startedAt: "2026-11-24T17:21:39.100Z" });
      const record = JSON.parse(bytes);
      await writeFile(join(home, "paseo.pid"), bytes);
      expect(() => f.module.isPidLockOwnerRunning(record)).toThrowError(
        expect.objectContaining({ code: "DAEMON_STATE_READ_FAILED" }),
      );
      const { readDaemonInstance, stopDaemonInstance } = await import("./daemon-instance.js");
      await expect(readDaemonInstance(home)).rejects.toMatchObject({
        code: "DAEMON_STATE_READ_FAILED",
      });
      await expect(f.module.isLocked(home)).rejects.toMatchObject({
        code: "DAEMON_STATE_READ_FAILED",
      });
      await expect(
        f.module.acquirePidLock(home, null, { ownerPid: pid + 1 }),
      ).rejects.toMatchObject({ code: "DAEMON_STATE_READ_FAILED" });
      await expect(stopDaemonInstance(home)).rejects.toMatchObject({
        code: "DAEMON_STATE_READ_FAILED",
      });
      expect(await readFile(join(home, "paseo.pid"), "utf8")).toBe(bytes);
      expect(f.kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("Darwin legacy lock inside the unshifted boot estimate keeps existing behavior", async () => {
    const f = await fixture();
    expect(f.module.isPidLockOwnerRunning({ ...lock(), startedAt: wakeTime.toISOString() })).toBe(
      true,
    );
    expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
  });

  test("Darwin a dead legacy PID remains abandoned without a birth lookup", async () => {
    const f = await fixture();
    f.kill.mockImplementation(() => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    });
    expect(f.module.isPidLockOwnerRunning(lock())).toBe(false);
    expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
  });

  test.each([undefined, "c6065930-45d4-4bd6-b2b2-813a470f4c87"])(
    "Darwin unavailable boot UUID keeps ownership unknown with recorded bootId=%s",
    async (recordedBoot) => {
      const f = await fixture();
      f.exec.mockImplementation((file) => {
        if (file === "/usr/sbin/sysctl") throw new Error("fixture sysctl failed");
        return "Tue Nov 24 17:21:39 2026\n";
      });
      expect(f.module.currentBootId()).toBeNull();
      expect(() => f.module.isPidLockOwnerRunning(lock(recordedBoot))).toThrowError(
        expect.objectContaining({ code: "DAEMON_STATE_READ_FAILED" }),
      );
      expect(f.exec.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(0);
    },
  );

  test("Linux boot_id still bypasses the shifted instant and rejects another boot", async () => {
    const f = await fixture("linux");
    expect(f.module.currentBootId()).toBe("linux-boot-fixture");
    expect(f.module.isPidLockOwnerRunning(lock("linux-boot-fixture"))).toBe(true);
    expect(f.module.isPidLockOwnerRunning(lock("another-boot"))).toBe(false);
    expect(f.readBootId).toHaveBeenCalledOnce();
    expect(f.exec).not.toHaveBeenCalled();
  });
});
