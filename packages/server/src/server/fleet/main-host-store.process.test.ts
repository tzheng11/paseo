import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MainHostProvenance, MainHostState } from "@getpaseo/protocol/fleet/main-host";
import { getPidLockInfo } from "../pid-lock.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { MainHostStore } from "./main-host-store.js";

const BASE_REVISION = "8046e550e32ac7fe9dc9720a00b35bd747950094";
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const execute = promisify(execFile);
const allocatorSource = fileURLToPath(new URL("./main-host-store.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const children = new Map<ChildProcess, boolean>();
let temporaryRoot: string;

const owner: MainHostProvenance = {
  principalId: "owner",
  clientId: "process-test-browser",
  sessionId: "process-test-session",
  serverId: "process-host",
  clientType: "browser",
};

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-main-process-"));
});

afterEach(async () => {
  await Promise.all([...children].map(([child, processGroup]) => stopChild(child, processGroup)));
  children.clear();
  await rm(temporaryRoot, { recursive: true, force: true });
});

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  // Inherit executable lookup and Windows runtime necessities, never owner credentials.
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
    XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
    PASEO_HOME: home,
    PASEO_SERVER_ID: "process-host",
    PASEO_RELAY_ENABLED: "0",
    PASEO_SERVICE_PROXY_ENABLED: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    PASEO_DICTATION_STT_PROVIDER: "openai",
    PASEO_VOICE_TURN_DETECTION_PROVIDER: "openai",
    PASEO_VOICE_STT_PROVIDER: "openai",
    PASEO_VOICE_TTS_PROVIDER: "openai",
    PASEO_NODE_INSPECT: "0",
    PASEO_LOG_LEVEL: "error",
    PASEO_LOG_FORMAT: "json",
    NODE_ENV: "test",
  };
}

async function createConfiguredHome(): Promise<{ home: string; configBytes: string }> {
  const home = path.join(temporaryRoot, "daemon-home");
  await mkdir(home);
  const configBytes = `${JSON.stringify(
    {
      version: 1,
      daemon: {
        listen: "127.0.0.1:0",
        autoArchiveAfterMerge: false,
        relay: { enabled: false },
        serviceProxy: { enabled: false },
      },
      agents: {
        providers: {
          claude: { enabled: false },
          codex: { enabled: false },
          copilot: { enabled: false },
          opencode: { enabled: false },
          pi: { enabled: false },
          antigravity: { enabled: false },
          muse: { enabled: false },
        },
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(path.join(home, "config.json"), configBytes);
  return { home, configBytes };
}

async function createPriorChoice(home: string): Promise<MainHostState> {
  const store = new MainHostStore({ paseoHome: home, serverId: "process-host" });
  await store.initialize();
  await store.set(
    { mainHost: "old-main", expectedGeneration: 0, requestId: "prior-complete-choice" },
    owner,
  );
  return store.snapshot();
}

interface RenameBoundary {
  type: "rename-boundary";
  phase: "before" | "after";
}

function waitForRenameBoundary(child: ChildProcess): Promise<RenameBoundary> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Allocator exited before the rename boundary (${code}, ${signal})`));
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "rename-boundary" ||
        !("phase" in message) ||
        (message.phase !== "before" && message.phase !== "after")
      ) {
        cleanup();
        reject(new Error("Allocator sent an unexpected process-test message"));
        return;
      }
      cleanup();
      resolve({ type: "rename-boundary", phase: message.phase });
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Allocator did not reach the fleet.json rename boundary within 30 seconds"));
    }, 30_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function startPausedAllocator(
  home: string,
  phase: "before" | "after",
): Promise<ChildProcess> {
  const entrypoint = path.join(temporaryRoot, "paused-allocator.mjs");
  await writeFile(
    entrypoint,
    `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const home = process.argv[2];
const phase = process.argv[3];
const fleetPath = path.join(home, "fleet.json");
const rename = fs.promises.rename;
const pause = async () => {
  process.send({ type: "rename-boundary", phase });
  await new Promise(() => {});
};
fs.promises.rename = async (source, destination) => {
  if (String(destination) === fleetPath && phase === "before") await pause();
  await rename(source, destination);
  if (String(destination) === fleetPath && phase === "after") await pause();
};
syncBuiltinESMExports();
const { MainHostStore } = await import(${JSON.stringify(pathToFileURL(allocatorSource).href)});
const store = new MainHostStore({ paseoHome: home, serverId: "process-host" });
await store.initialize();
await store.set(
  { mainHost: "new-main", expectedGeneration: 1, requestId: "interrupted-change" },
  ${JSON.stringify(owner)},
);
throw new Error("The write did not pause at its rename boundary");
`,
  );
  const child = spawn(process.execPath, ["--import", tsxLoader, entrypoint, home, phase], {
    cwd: repositoryRoot,
    env: isolatedEnvironment(home),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.set(child, false);
  expect(await waitForRenameBoundary(child)).toEqual({ type: "rename-boundary", phase });
  return child;
}

async function killAtBoundary(child: ChildProcess): Promise<void> {
  const exited = once(child, "exit");
  expect(child.kill("SIGKILL")).toBe(true);
  const [code, signal] = await exited;
  expect(code).toBe(null);
  expect(signal).toBe("SIGKILL");
  children.delete(child);
}

async function stopChild(child: ChildProcess, processGroup: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform === "win32" && processGroup && child.pid !== undefined) {
    await execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5_000 });
  } else if (processGroup && child.pid !== undefined) {
    process.kill(-child.pid, "SIGTERM");
  } else {
    child.kill("SIGTERM");
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          if (processGroup && process.platform !== "win32" && child.pid !== undefined)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
          reject(new Error("Isolated process did not terminate within 5 seconds"));
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function availablePort(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close(() => reject(new Error("Failed to lease an isolated daemon port")));
        return;
      }
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
  return port === 6767 || port === 6768 ? availablePort() : port;
}

async function extractBaseline(): Promise<string> {
  try {
    await execute("git", ["cat-file", "-e", `${BASE_REVISION}^{commit}`], { cwd: repositoryRoot });
  } catch (error) {
    throw new Error(
      `Rollback fixture needs local Git commit ${BASE_REVISION}. Fetch complete repository history before running this test; it never downloads or skips the baseline.`,
      { cause: error },
    );
  }
  const baseline = path.join(temporaryRoot, "baseline-source");
  const archive = path.join(temporaryRoot, "baseline.tar");
  await mkdir(baseline);
  await execute(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      BASE_REVISION,
      "package.json",
      "packages/server",
    ],
    { cwd: repositoryRoot },
  );
  await execute("tar", ["-xf", archive, "-C", baseline]);
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(baseline, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // Hoisted installs can keep server-specific versions (for example p-limit)
  // below this workspace; use those same versions for the archived source.
  await symlink(
    path.join(repositoryRoot, "packages/server/node_modules"),
    path.join(baseline, "packages/server/node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    access(path.join(baseline, "packages/server/src/server/fleet/main-host-store.ts")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  return baseline;
}

async function waitForDaemon(child: ChildProcess, port: number, home: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Baseline daemon exited before listening (${child.exitCode}, ${child.signalCode})`,
      );
    // HTTP binds before plugin startup finishes. The supervisor publishes its
    // listen receipt only after daemon.start() has enabled WebSocket acceptance.
    const ready = await getPidLockInfo(home);
    if (
      ready?.pid === child.pid &&
      ready?.serverId === "process-host" &&
      ready?.listen === `127.0.0.1:${port}`
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Baseline daemon did not listen within 60 seconds; inspect only its temporary home",
  );
}

async function connectCurrentDaemon(home: string): Promise<{
  child: ChildProcess;
  client: DaemonClient;
}> {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, "scripts/supervisor-entrypoint.ts", "--dev", "--no-mcp", "--no-relay"],
    {
      cwd: path.join(repositoryRoot, "packages/server"),
      env: {
        ...isolatedEnvironment(home),
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_NODE_ENV: "development",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  children.set(child, true);
  await waitForDaemon(child, port, home);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "main-startup-process-test",
    clientType: "cli",
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  return { child, client };
}

describe("DOTS2-114 · real process interruption and rollback", () => {
  test.each(["missing-key", "invalid-fleet"] as const)(
    "%s disables only Main while the real daemon boots and serves other RPCs",
    async (failure) => {
      const { home, configBytes } = await createConfiguredHome();
      await createPriorChoice(home);
      const fleetPath = path.join(home, "fleet.json");
      const keyPath = path.join(home, "fleet-allocator-key.pem");
      if (failure === "missing-key") await rm(keyPath);
      else await writeFile(fleetPath, '{"version":1,"state":');
      const before = await readFile(fleetPath, "utf8");
      const { child, client } = await connectCurrentDaemon(home);
      try {
        expect(client.getLastServerInfoMessage()?.features?.mainHost).toBe(false);
        expect((await client.getDaemonConfig()).config.autoArchiveAfterMerge).toBe(false);
        await expect(client.getMainHost()).rejects.toThrow(
          "Update this host to use Main host. The previous setting is unchanged.",
        );
        expect(await readFile(fleetPath, "utf8")).toBe(before);
        expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(configBytes);
        expect(await readFile(path.join(home, "daemon.log"), "utf8")).toContain(
          "Main host initialization failed; Main is disabled for this daemon run",
        );
        if (failure === "missing-key")
          await expect(access(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await client.close();
        await stopChild(child, true);
        children.delete(child);
      }
    },
    90_000,
  );

  test("server_info republishes a changed Main setting without an app polling it", async () => {
    const { home } = await createConfiguredHome();
    await createPriorChoice(home);
    const { child, client } = await connectCurrentDaemon(home);
    try {
      await client.observeEvents(["status.server_info"]).ready;
      expect(client.getLastServerInfoMessage()?.mainHost?.choice?.generation).toBe(1);
      await client.setMainHost({
        mainHost: "new-main",
        expectedGeneration: 1,
        requestId: "server-info-publication",
      });
      // This reads only the cached server_info frame, never fleet.get or an app query.
      await expect
        .poll(() => client.getLastServerInfoMessage()?.mainHost?.choice?.generation)
        .toBe(2);
      expect(client.getLastServerInfoMessage()?.mainHost).toMatchObject({
        choice: { mainHost: "new-main", generation: 2 },
        held: true,
      });
    } finally {
      await client.close();
      await stopChild(child, true);
      children.delete(child);
    }
  }, 90_000);

  test("SIGKILL between fleet-file write and rename preserves the complete previous choice", async () => {
    const { home, configBytes } = await createConfiguredHome();
    const prior = await createPriorChoice(home);
    const before = await readFile(path.join(home, "fleet.json"), "utf8");
    const child = await startPausedAllocator(home, "before");
    expect(await readFile(path.join(home, "fleet.json.lock"), "utf8")).toBe(String(child.pid));
    expect(
      (await readdir(home)).filter((name) => /^fleet\.json\..*\.tmp$/.test(name)),
    ).toHaveLength(1);
    await killAtBoundary(child);

    const restarted = new MainHostStore({ paseoHome: home, serverId: "process-host" });
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(prior);
    expect(await readFile(path.join(home, "fleet.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(configBytes);
    await expect(access(path.join(home, "fleet.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 45_000);

  test("SIGKILL immediately after fleet-file rename preserves the complete new choice", async () => {
    const { home, configBytes } = await createConfiguredHome();
    await createPriorChoice(home);
    const child = await startPausedAllocator(home, "after");
    await killAtBoundary(child);

    const restarted = new MainHostStore({ paseoHome: home, serverId: "process-host" });
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      choice: {
        mainHost: "new-main",
        previousMainHost: "old-main",
        generation: 2,
        requestId: "interrupted-change",
        setBy: owner,
      },
      held: true,
      delivery: null,
    });
    expect(JSON.parse(await readFile(path.join(home, "fleet.json"), "utf8")).state).toEqual(
      restarted.snapshot(),
    );
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(configBytes);
    await expect(access(path.join(home, "fleet.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 45_000);

  test("the actual pre-Main baseline daemon starts and ignores fleet.json with unchanged config", async () => {
    const { home, configBytes } = await createConfiguredHome();
    const prior = await createPriorChoice(home);
    const fleetBefore = await readFile(path.join(home, "fleet.json"), "utf8");
    const baseline = await extractBaseline();
    const port = await availablePort();
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "scripts/supervisor-entrypoint.ts",
        "--dev",
        "--no-mcp",
        "--no-relay",
      ],
      {
        cwd: path.join(baseline, "packages/server"),
        env: {
          ...isolatedEnvironment(home),
          PASEO_LISTEN: `127.0.0.1:${port}`,
          PASEO_NODE_ENV: "development",
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    children.set(child, true);
    await waitForDaemon(child, port, home);
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: "rollback-process-test",
      clientType: "cli",
      connectTimeoutMs: 10_000,
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.mainHost).toBeUndefined();
      const config = await client.getDaemonConfig();
      expect(config.config.autoArchiveAfterMerge).toBe(false);
      expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(configBytes);
      expect(await readFile(path.join(home, "fleet.json"), "utf8")).toBe(fleetBefore);
    } finally {
      await client.close();
      await stopChild(child, true);
      children.delete(child);
    }
    const upgradedAgain = new MainHostStore({ paseoHome: home, serverId: "process-host" });
    await upgradedAgain.initialize();
    expect(upgradedAgain.snapshot()).toEqual(prior);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(configBytes);
  }, 120_000);
});
