import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readdir, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

interface BootBinding {
  serverId: string;
  generation: string;
  epoch: string;
  pid: number;
}

interface BootOptions {
  directory: string;
  home: string;
  timeoutMs: number;
}

type Phase = "closed" | "expired" | "releasing" | "released" | "failed" | "drained";

interface BootSnapshot extends BootBinding {
  protocolVersion: 1;
  phase: Phase;
  capabilities: { bootClosed: true; activeDrain: false };
  release: { requestId: string; outcome: "starting" | "started" | "unknown" } | null;
  drain: { scope: "unreleased-boot"; acceptedWork: 0; requestId: string } | null;
}

export function maintenanceBootOptions(env: NodeJS.ProcessEnv): BootOptions | null {
  if (env.PASEO_MAINTENANCE_BOOT === undefined) {
    if (
      env.PASEO_MAINTENANCE_CONTROL_DIR !== undefined ||
      env.PASEO_MAINTENANCE_BOOT_TIMEOUT_MS !== undefined
    ) {
      throw new Error("MAINTENANCE_MODE_REQUIRED");
    }
    return null;
  }
  if (env.PASEO_MAINTENANCE_BOOT !== "closed") throw new Error("MAINTENANCE_MODE_INVALID");
  if (env.PASEO_SERVER_ID !== undefined) throw new Error("MAINTENANCE_SERVER_ID_OVERRIDE");
  const directory = env.PASEO_MAINTENANCE_CONTROL_DIR;
  const home = env.PASEO_HOME;
  if (!directory || !home || !path.isAbsolute(directory) || !path.isAbsolute(home)) {
    throw new Error("MAINTENANCE_PATH_REQUIRED");
  }
  const raw = env.PASEO_MAINTENANCE_BOOT_TIMEOUT_MS ?? "300000";
  const timeoutMs = Number(raw);
  if (!/^\d+$/.test(raw) || timeoutMs < 1 || timeoutMs > 900000) {
    throw new Error("MAINTENANCE_TIMEOUT_INVALID");
  }
  return { directory, home, timeoutMs };
}

async function exclusiveFile(file: string, value: string, mode: number): Promise<void> {
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await fd.writeFile(value);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function existingServerId(home: string, uid: number): Promise<string> {
  const idPath = path.join(home, "server-id");
  const id = await open(idPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let serverId: string;
  try {
    const before = await id.stat();
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || before.size > 1024) {
      throw new Error("MAINTENANCE_SERVER_ID_METADATA");
    }
    serverId = (await id.readFile("utf8")).trim();
    const after = await id.stat();
    const leaf = await lstat(idPath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      after.dev !== leaf.dev ||
      after.ino !== leaf.ino ||
      !/^srv_[A-Za-z0-9_-]+$/.test(serverId)
    ) {
      throw new Error("MAINTENANCE_SERVER_ID_CHANGED");
    }
  } finally {
    await id.close();
  }
  return serverId;
}

function credentialMatches(value: unknown, token: string): boolean {
  const expected = `Bearer ${token}`;
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}

/** The normal bootstrap is not constructed until an explicit, one-shot release. */
export async function startMaintenanceBoot(options: BootOptions, start: () => Promise<void>) {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 900000
  ) {
    throw new Error("MAINTENANCE_TIMEOUT_INVALID");
  }
  if (process.platform === "win32" || !process.getuid) {
    throw new Error("MAINTENANCE_REQUIRES_UNIX_SOCKET");
  }
  const uid = process.getuid();
  const directory = await lstat(options.directory);
  if (
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o777) !== 0o700 ||
    (await realpath(options.directory)) !== options.directory ||
    (await readdir(options.directory)).length !== 0
  )
    throw new Error("MAINTENANCE_DIRECTORY_NOT_PRIVATE_EMPTY");
  if ((await realpath(options.home)) !== options.home) throw new Error("MAINTENANCE_HOME_ALIAS");
  const serverId = await existingServerId(options.home, uid);
  const socketPath = path.join(options.directory, "control.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("MAINTENANCE_SOCKET_PATH_TOO_LONG");
  const binding: BootBinding = {
    serverId,
    generation: randomUUID(),
    epoch: randomUUID(),
    pid: process.pid,
  };
  const token = randomBytes(32).toString("hex");
  let phase: Phase = "closed";
  let release: BootSnapshot["release"] = null;
  let drain: BootSnapshot["drain"] = null;
  let releaseTask: Promise<void> | null = null;
  const deadline = performance.now() + options.timeoutMs;
  const snapshot = (): BootSnapshot => ({
    ...binding,
    protocolVersion: 1,
    phase,
    capabilities: { bootClosed: true, activeDrain: false },
    release: release ? { ...release } : null,
    drain: drain ? { ...drain } : null,
  });
  const expire = () => {
    if (phase === "closed") phase = "expired";
  };
  const timer = setTimeout(expire, options.timeoutMs);
  timer.unref();
  const log = async (name: string, value: unknown) => {
    await exclusiveFile(path.join(options.directory, name), JSON.stringify(value) + "\n", 0o400);
    const fd = await open(options.directory, constants.O_RDONLY);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  };
  const respond = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  const checkInputs = async () => {
    const currentDirectory = await lstat(options.directory);
    if (
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino ||
      currentDirectory.uid !== uid ||
      (currentDirectory.mode & 0o777) !== 0o700 ||
      (await realpath(options.directory)) !== options.directory ||
      (await existingServerId(options.home, uid)) !== binding.serverId
    ) {
      phase = "failed";
      throw new Error("MAINTENANCE_INPUTS_CHANGED");
    }
  };
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!credentialMatches(req.headers.authorization, token)) {
      respond(res, 401, { error: "MAINTENANCE_CREDENTIAL_REQUIRED" });
      return;
    }
    if (performance.now() >= deadline) expire();
    if (req.method === "GET" && req.url === "/v1/inspect") {
      respond(res, 200, snapshot());
      return;
    }
    if (req.method !== "POST" || (req.url !== "/v1/release" && req.url !== "/v1/drain")) {
      respond(res, 404, { error: "MAINTENANCE_ROUTE_UNSUPPORTED" });
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 4096) {
        respond(res, 413, { error: "MAINTENANCE_BODY_TOO_LARGE" });
        return;
      }
    }
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== "object") throw new Error("MAINTENANCE_BINDING_REQUIRED");
    const value = body as Record<string, unknown>;
    if (
      Object.entries(binding).some(([key, item]) => value[key] !== item) ||
      typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
    ) {
      respond(res, 409, { error: "MAINTENANCE_BINDING_CHANGED" });
      return;
    }
    await checkInputs();
    // Re-check after body and identity I/O. Expiry is never an implicit release.
    if (performance.now() >= deadline) expire();
    if (phase !== "closed") {
      respond(res, 409, { error: "MAINTENANCE_NOT_CLOSED", ...snapshot() });
      return;
    }
    if (req.url === "/v1/drain") {
      phase = "drained";
      drain = { scope: "unreleased-boot", acceptedWork: 0, requestId: value.requestId };
      await log("drained.json", snapshot());
      respond(res, 200, snapshot());
      return;
    }
    phase = "releasing";
    release = { requestId: value.requestId, outcome: "starting" };
    // Commit the one-shot decision before invoking any normal runtime code.
    await log("release.json", snapshot());
    respond(res, 202, snapshot());
    releaseTask = Promise.resolve()
      .then(start)
      .then(async () => {
        phase = "released";
        release = { requestId: value.requestId as string, outcome: "started" };
        await log("started.json", snapshot());
        return;
      })
      .catch(async () => {
        // Startup can have had effects. Never retry or call that a zero-work drain.
        phase = "failed";
        release = { requestId: value.requestId as string, outcome: "unknown" };
        await log("failed.json", snapshot());
      });
    void releaseTask.catch(() => {
      phase = "failed";
    });
  };
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (phase === "releasing" || phase === "drained") {
        phase = "failed";
        drain = null;
      }
      if (!res.headersSent) respond(res, 400, { error: "MAINTENANCE_REQUEST_FAILED" });
      else res.destroy();
    });
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  });
  try {
    await exclusiveFile(path.join(options.directory, "token"), token, 0o600);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    await log("identity.json", snapshot());
  } catch (error) {
    clearTimeout(timer);
    server.close();
    throw error;
  }
  return {
    socketPath,
    inspect: snapshot,
    async close() {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      await releaseTask;
    },
  };
}

export async function startWorkerWithMaintenance(start: () => Promise<void>, env = process.env) {
  const options = maintenanceBootOptions(env);
  if (!options) {
    await start();
    return null;
  }
  return startMaintenanceBoot(options, start);
}
