import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { maintenanceBootOptions, startWorkerWithMaintenance } from "./maintenance-boot.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(start = vi.fn(async () => {}), timeout = 300000) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pmb-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const directory = path.join(root, "ctl");
  await mkdir(home, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(home, "server-id"), "srv_test-original\n", { mode: 0o600 });
  const control = await startWorkerWithMaintenance(start, {
    PASEO_HOME: home,
    PASEO_MAINTENANCE_BOOT: "closed",
    PASEO_MAINTENANCE_CONTROL_DIR: directory,
    PASEO_MAINTENANCE_BOOT_TIMEOUT_MS: String(timeout),
  });
  if (!control) throw new Error("missing control");
  cleanups.push(() => control.close());
  const token = await readFile(path.join(directory, "token"), "utf8");
  const identity = control.inspect();
  return {
    control,
    directory,
    home,
    start,
    token,
    bound: { ...identity, requestId: "request-one" },
    request(method: string, url: string, body: unknown = {}, credential = token) {
      return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: control.socketPath,
            path: url,
            method,
            headers: { Authorization: `Bearer ${credential}`, Connection: "close" },
          },
          (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (value) => {
              raw += value;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
          },
        );
        req.on("error", reject);
        req.end(method === "GET" ? undefined : JSON.stringify(body));
      });
    },
  };
}

test("closed boot never constructs any normal producer and exposes no ordinary routes", async () => {
  const dispatches: string[] = [];
  const f = await fixture(
    vi.fn(async () => {
      dispatches.push(
        "schedule",
        "plugin",
        "hook",
        "hub",
        "relay",
        "provider",
        "creation",
        "websocket",
      );
    }),
  );
  expect((await f.request("GET", "/v1/inspect")).body).toMatchObject({
    phase: "closed",
    serverId: "srv_test-original",
    capabilities: { bootClosed: true, activeDrain: false },
  });
  for (const url of [
    "/api/health",
    "/mcp",
    "/ws",
    "/",
    "/v1/create",
    "/v1/reload",
    "/v1/schedule",
  ]) {
    expect((await f.request("POST", url)).status).toBe(404);
  }
  expect(f.start).not.toHaveBeenCalled();
  expect(dispatches).toEqual([]);
  expect(await readFile(path.join(f.home, "server-id"), "utf8")).toBe("srv_test-original\n");
  expect((await stat(path.join(f.directory, "token"))).mode & 0o777).toBe(0o600);
  expect((await stat(f.control.socketPath)).mode & 0o777).toBe(0o600);
});

test("only a credentialed exact-generation release starts bootstrap, once", async () => {
  const f = await fixture();
  expect((await f.request("POST", "/v1/release", f.bound, "wrong")).status).toBe(401);
  for (const changed of [
    { epoch: "old" },
    { generation: "old" },
    { serverId: "srv_other" },
    { pid: -1 },
  ]) {
    expect((await f.request("POST", "/v1/release", { ...f.bound, ...changed })).status).toBe(409);
  }
  expect(f.start).not.toHaveBeenCalled();
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(202);
  await vi.waitFor(() => expect(f.control.inspect().phase).toBe("released"));
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(path.join(f.directory, "release.json"), "utf8"))).toMatchObject({
    generation: f.bound.generation,
    release: { requestId: "request-one", outcome: "starting" },
  });
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(409);
  expect((await f.request("POST", "/v1/drain", f.bound)).status).toBe(409);
  expect(f.control.inspect().capabilities.activeDrain).toBe(false);
});

test("concurrent releases cannot construct a second daemon", async () => {
  let finish!: () => void;
  const f = await fixture(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const responses = await Promise.all([
    f.request("POST", "/v1/release", f.bound),
    f.request("POST", "/v1/release", { ...f.bound, requestId: "second" }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
  expect(f.start).toHaveBeenCalledTimes(1);
  finish();
});

test("expired boot stays closed, even after a valid controller request", async () => {
  const f = await fixture(undefined, 1);
  await vi.waitFor(() => expect(f.control.inspect().phase).toBe("expired"));
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(409);
  expect(f.start).not.toHaveBeenCalled();
});

test("unreleased drain proves only this boot accepted no work and permanently bars release", async () => {
  const f = await fixture();
  const reply = await f.request("POST", "/v1/drain", f.bound);
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    phase: "drained",
    drain: {
      scope: "unreleased-boot",
      acceptedWork: 0,
      requestId: "request-one",
    },
    capabilities: { activeDrain: false },
  });
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(409);
  expect(f.start).not.toHaveBeenCalled();
});

test("failed decision persistence never calls normal bootstrap", async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, "release.json"), "reserved", { flag: "wx" });
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(400);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.control.inspect().phase).toBe("failed");
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(409);
});

test("startup failure stays unknown and cannot be replayed or credited drained", async () => {
  const f = await fixture(
    vi.fn(async () => {
      throw new Error("partial startup");
    }),
  );
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(202);
  await vi.waitFor(() =>
    expect(f.control.inspect()).toMatchObject({
      phase: "failed",
      release: { outcome: "unknown" },
      drain: null,
    }),
  );
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(409);
  expect((await f.request("POST", "/v1/drain", f.bound)).status).toBe(409);
  expect(f.start).toHaveBeenCalledTimes(1);
});

test("websocket upgrade is refused without invoking normal bootstrap", async () => {
  const f = await fixture();
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(f.control.socketPath, () =>
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      ),
    );
    let raw = "";
    socket.on("data", (data) => {
      raw += data;
    });
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });
  expect(reply).toContain("503 Service Unavailable");
  expect(f.start).not.toHaveBeenCalled();
});

test("normal mode runs unchanged and invalid maintenance configuration never falls back", async () => {
  const start = vi.fn(async () => {});
  expect(await startWorkerWithMaintenance(start, {})).toBeNull();
  expect(start).toHaveBeenCalledTimes(1);
  for (const env of [
    { PASEO_MAINTENANCE_BOOT: "open" },
    { PASEO_MAINTENANCE_CONTROL_DIR: "/tmp" },
    { PASEO_MAINTENANCE_BOOT: "closed" },
    { PASEO_MAINTENANCE_BOOT_TIMEOUT_MS: "300000" },
    {
      PASEO_MAINTENANCE_BOOT: "closed",
      PASEO_HOME: "/tmp",
      PASEO_SERVER_ID: "srv_override",
      PASEO_MAINTENANCE_CONTROL_DIR: "/tmp",
    },
  ]) {
    await expect(startWorkerWithMaintenance(start, env)).rejects.toThrow();
  }
  expect(start).toHaveBeenCalledTimes(1);
  expect(() =>
    maintenanceBootOptions({
      PASEO_MAINTENANCE_BOOT: "closed",
      PASEO_HOME: "/tmp",
      PASEO_MAINTENANCE_CONTROL_DIR: "/tmp",
      PASEO_MAINTENANCE_BOOT_TIMEOUT_MS: "NaN",
    }),
  ).toThrow();
});

test("server identity drift and a reused control directory cannot silently start a daemon", async () => {
  const f = await fixture();
  await writeFile(path.join(f.home, "server-id"), "srv_changed\n");
  expect((await f.request("POST", "/v1/release", f.bound)).status).toBe(400);
  expect(f.start).not.toHaveBeenCalled();
  const otherStart = vi.fn(async () => {});
  await expect(
    startWorkerWithMaintenance(otherStart, {
      PASEO_HOME: f.home,
      PASEO_MAINTENANCE_BOOT: "closed",
      PASEO_MAINTENANCE_CONTROL_DIR: f.directory,
    }),
  ).rejects.toThrow("MAINTENANCE_DIRECTORY_NOT_PRIVATE_EMPTY");
  expect(otherStart).not.toHaveBeenCalled();
});

test("the actual worker waits before bootstrap and still exits after supervisor loss", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pmbw-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const directory = path.join(root, "ctl");
  await mkdir(home, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(home, "server-id"), "srv_actual-closed-worker\n", { mode: 0o600 });
  // Loading normal configuration is itself forbidden before release.
  await writeFile(path.join(home, "config.json"), "invalid normal config sentinel");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./daemon-worker.ts", import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PASEO_HOME: home,
        PASEO_MAINTENANCE_BOOT: "closed",
        PASEO_MAINTENANCE_CONTROL_DIR: directory,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  const exit = once(child, "exit");
  cleanups.push(async () => {
    child.kill("SIGTERM"); // owned direct-child handle, never a PID census or product daemon
    await exit;
  });
  await vi.waitFor(
    async () => {
      expect(child.exitCode, errors).toBeNull();
      const identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
      expect(identity).toMatchObject({
        phase: "closed",
        serverId: "srv_actual-closed-worker",
        pid: child.pid,
      });
    },
    { timeout: 10000 },
  );
  expect((await readdir(home)).sort()).toEqual(["config.json", "server-id"]);
  expect(errors).toBe("");
  child.disconnect();
  expect(await exit).toEqual([0, null]);
});
