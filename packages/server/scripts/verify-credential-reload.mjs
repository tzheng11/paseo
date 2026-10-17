#!/usr/bin/env node
// A compiled CLI -> compiled daemon -> fixture provider process canary. No model calls.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const script = fileURLToPath(import.meta.url);
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const runtime = path.resolve(
  argument("--runtime-root", path.join(path.dirname(script), "../../..")),
);
const load = (relative) => import(pathToFileURL(path.join(runtime, relative)).href);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixtureProvider() {
  const journal = argument("--journal");
  appendFileSync(journal, `${JSON.stringify({ kind: "spawn", pid: process.pid })}\n`);
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let threadId = "fixture-thread";
  const notification = (method, params) => send({ method, params });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      appendFileSync(
        journal,
        `${JSON.stringify({ kind: "request", pid: process.pid, method: request.method })}\n`,
      );
      let result = {};
      switch (request.method) {
        case "initialize":
          result = { userAgent: "fixture/0.159.2" };
          break;
        case "model/list":
          result = {
            data: [{ id: "fixture-model", isDefault: true, defaultReasoningEffort: "medium" }],
          };
          break;
        case "config/read":
          result = { config: {} };
          break;
        case "skills/list":
        case "collaborationMode/list":
        case "thread/loaded/list":
          result = { data: [] };
          break;
        case "thread/start":
          result = { thread: { id: threadId } };
          break;
        case "thread/resume":
          threadId = request.params.threadId;
          setTimeout(() => send({ id: request.id, result: { thread: { id: threadId } } }), 750);
          return;
        case "thread/read":
          result = { thread: { id: threadId, historyMode: "paginated" } };
          break;
        case "thread/turns/list":
          result = { data: [{ id: "historical-turn" }], nextCursor: null };
          break;
        case "thread/items/list":
          result = {
            data: [
              {
                turnId: "historical-turn",
                item: {
                  type: "agentMessage",
                  id: "historical-message",
                  text: "fixture native history is available",
                },
              },
            ],
            nextCursor: null,
          };
          break;
        case "turn/start":
          result = { turn: { id: "fixture-busy-turn" } };
          setTimeout(
            () => notification("turn/started", { threadId, turn: { id: "fixture-busy-turn" } }),
            0,
          );
          break;
        case "turn/interrupt":
          setTimeout(
            () =>
              notification("turn/completed", {
                threadId,
                turn: { id: "fixture-busy-turn", status: "interrupted", items: [] },
              }),
            0,
          );
          break;
        default:
          break;
      }
      send({ id: request.id, result });
    })
    .on("close", () => process.exit(0));
}

async function fixtureDaemon() {
  const home = argument("--home");
  const journal = argument("--journal");
  const port = Number(argument("--port", "6768"));
  assert.notEqual(port, 6767, "Never use the live daemon port");
  const require = createRequire(path.join(runtime, "packages/server/package.json"));
  const logger = require("pino")({ level: "silent" });
  const { createPaseoDaemon } = await load("packages/server/dist/server/server/bootstrap.js");
  const { BuiltinPluginLoader } = await load(
    "packages/server/dist/server/server/plugins/builtin/index.js",
  );
  const { CodexAppServerAgentClient } = await load(
    "packages/server/dist/server/server/agent/providers/codex-app-server-agent.js",
  );
  const provider = new CodexAppServerAgentClient(logger);
  // Test injection replaces only executable launch and discovery; the actual adapter runs unchanged.
  provider.goalsEnabledPromise = Promise.resolve(false);
  provider.autoReviewEnabledPromise = Promise.resolve(false);
  provider.spawnAppServer = async () =>
    spawn(process.execPath, [script, "--fixture-provider", "--journal", journal], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
    });
  provider.isAvailable = async () => true;
  provider.fetchCatalog = async () => ({
    provider: "codex",
    models: [{ provider: "codex", id: "fixture-model", label: "Fixture", isDefault: true }],
    modes: [],
  });
  provider.listImportableSessions = async () => [];
  const daemon = await createPaseoDaemon(
    {
      listen: `127.0.0.1:${port}`,
      paseoHome: home,
      agentStoragePath: path.join(home, "agents"),
      staticDir: path.join(home, "static"),
      mcpEnabled: false,
      relayEnabled: false,
      relayEndpoint: "invalid",
      appBaseUrl: "https://app.paseo.sh",
      corsAllowedOrigins: [],
      hostnames: [],
      agentClients: { codex: provider },
      pluginsEnabled: false,
      voiceLlmProvider: null,
    },
    logger,
    { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
  );
  await daemon.start();
  const agent = await daemon.agentManager.createAgent(
    { provider: "codex", cwd: home, model: "fixture-model" },
    undefined,
    { workspaceId: undefined },
  );
  for (let index = 0; index < 128; index++) {
    await daemon.agentManager.appendTimelineItem(agent.id, {
      type: index % 2 ? "assistant_message" : "user_message",
      text: `${index}: ${"synthetic history ".repeat(4096)}`,
      messageId: `fixture-${index}`,
    });
  }
  const snapshot = () => ({
    hash: hash(daemon.agentManager.getTimeline(agent.id)),
    epoch: daemon.agentManager.getTimelineEpoch(agent.id),
    timelineBytes: Buffer.byteLength(JSON.stringify(daemon.agentManager.getTimeline(agent.id))),
    lifecycle: daemon.agentManager.getAgent(agent.id)?.lifecycle,
  });
  process.send({
    ready: true,
    port: daemon.getListenTarget().port,
    agentId: agent.id,
    ...snapshot(),
  });
  process.on("message", async (request) => {
    try {
      let value;
      if (request.action === "snapshot") value = snapshot();
      if (request.action === "busy") {
        void daemon.agentManager.runAgent(agent.id, "synthetic fixture turn").catch(() => {});
        await daemon.agentManager.waitForAgentRunStart(agent.id);
        value = { lifecycle: daemon.agentManager.getAgent(agent.id)?.lifecycle };
      }
      if (request.action === "stop") {
        await daemon.agentManager.cancelAgentRun(agent.id);
        value = {};
      }
      if (request.action === "shutdown") {
        await daemon.stop();
        process.send({ id: request.id, value: {} });
        process.exit(0);
      }
      process.send({ id: request.id, value });
    } catch (error) {
      process.send({ id: request.id, error: error.message });
    }
  });
}

async function runCanary() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-credential-reload-canary-"));
  const home = path.join(directory, "home");
  mkdirSync(path.join(home, "static"), { recursive: true });
  const journal = path.join(directory, "provider-methods.jsonl");
  writeFileSync(journal, "");
  let port = Number(argument("--port", "0"));
  assert.notEqual(port, 6767);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/PASEO|CODEX|CLAUDE|ANTHROPIC|OPENAI|TOKEN|SECRET|PASSWORD|API_KEY/.test(key),
    ),
  );
  Object.assign(env, {
    HOME: home,
    PASEO_HOME: home,
    CODEX_HOME: path.join(home, "codex"),
    CODEX_SQLITE_HOME: path.join(home, "codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    NODE_OPTIONS: "",
  });
  const child = spawn(
    process.execPath,
    [
      script,
      "--fixture-daemon",
      "--runtime-root",
      runtime,
      "--home",
      home,
      "--journal",
      journal,
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], env },
  );
  child.stdout.on("data", (data) => appendFileSync(path.join(directory, "daemon.log"), data));
  child.stderr.on("data", (data) => appendFileSync(path.join(directory, "daemon.log"), data));
  const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.on("exit", (code) => {
    rejectReady(new Error(`Fixture daemon exited (${code}); ${directory}/daemon.log`));
    for (const item of pending.values()) item.reject(new Error("Fixture daemon exited"));
  });
  child.on("message", (message) => {
    if (message.ready) resolveReady(message);
    const item = pending.get(message.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve(message.value);
    }
  });
  const rpc = (action) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => reject(new Error(`Fixture IPC timeout: ${action}`)), 20_000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, action });
    });
  const exec = promisify(execFile);
  const cli = async (args) => {
    const { stdout } = await exec(
      process.execPath,
      [
        path.join(runtime, "packages/cli/bin/paseo"),
        ...args,
        "--host",
        `127.0.0.1:${port}`,
        "--json",
      ],
      { env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const events = () =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const spawns = () => events().filter((event) => event.kind === "spawn").length;
  const artifactHashes = Object.fromEntries(
    [
      "packages/server/dist/server/server/agent/agent-manager.js",
      "packages/server/dist/server/server/agent/providers/codex-app-server-agent.js",
      "packages/server/dist/server/server/agent/providers/claude/agent.js",
      "packages/cli/dist/commands/agent/reload.js",
      "packages/cli/dist/commands/agent/reload-status.js",
    ].map((relative) => [
      relative,
      createHash("sha256")
        .update(readFileSync(path.join(runtime, relative)))
        .digest("hex"),
    ]),
  );
  const evidence = { runtime, port, directory, modelCalls: 0, artifactHashes };
  try {
    const startupDeadline = setTimeout(
      () => rejectReady(new Error("Fixture daemon startup timeout")),
      30_000,
    );
    const initial = await ready.finally(() => clearTimeout(startupDeadline));
    assert.ok(initial.timelineBytes > 1_000_000, "Seed a substantial committed timeline");
    port = initial.port;
    evidence.port = port;
    evidence.initial = initial;
    const operationId = randomUUID();
    const beforeSpawns = spawns();
    const start = await cli([
      "agent",
      "reload",
      initial.agentId,
      "--only-if-idle",
      "--preserve-history",
      "--operation-id",
      operationId,
    ]);
    assert.equal(start.operationId, operationId);
    assert.equal(start.agentId, initial.agentId);
    assert.equal(start.status, "pending");
    evidence.admission = start;
    let status;
    for (let attempt = 0; attempt < 40; attempt++) {
      status = await cli(["agent", "reload-status", operationId]);
      if (status.status !== "pending") break;
      await pause(100);
    }
    assert.equal(status.status, "completed");
    evidence.completed = status;
    assert.equal(spawns() - beforeSpawns, 1);
    const repeated = await cli([
      "agent",
      "reload",
      initial.agentId,
      "--only-if-idle",
      "--preserve-history",
      "--operation-id",
      operationId,
    ]);
    assert.equal(repeated.status, "completed");
    assert.equal(spawns() - beforeSpawns, 1);
    const preserved = await rpc("snapshot");
    assert.equal(preserved.hash, initial.hash);
    assert.equal(preserved.epoch, initial.epoch);
    evidence.preserved = preserved;
    evidence.reloadWriterSpawns = spawns() - beforeSpawns;
    assert.equal(events().filter((event) => event.method === "thread/read").length, 0);
    const require = createRequire(path.join(runtime, "packages/server/package.json"));
    const { WebSocket } = require("ws");
    const { DaemonClient } = await load("packages/client/dist/daemon-client.js");
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: `clid_canary_${randomUUID()}`,
      clientType: "cli",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
    });
    try {
      await client.connect();
      const page = await client.fetchAgentTimelineHistory({
        agentId: initial.agentId,
        operation: "windows",
      });
      assert.match(JSON.stringify(page), /fixture native history is available/);
      evidence.deferredHistory = {
        requested: true,
        providerReadCount: events().filter((event) => event.method === "thread/read").length,
      };
    } finally {
      await client.close();
    }
    await rpc("busy");
    const busyOperation = randomUUID();
    const beforeBusy = spawns();
    await cli([
      "agent",
      "reload",
      initial.agentId,
      "--only-if-idle",
      "--preserve-history",
      "--operation-id",
      busyOperation,
    ]);
    let refusal;
    for (let attempt = 0; attempt < 20; attempt++) {
      refusal = await cli(["agent", "reload-status", busyOperation]);
      if (refusal.status !== "pending") break;
      await pause(50);
    }
    assert.equal(refusal.status, "refused");
    assert.equal(refusal.reasonCode, "AGENT_RELOAD_BUSY");
    assert.equal(spawns(), beforeBusy);
    assert.equal((await rpc("snapshot")).lifecycle, "running");
    evidence.busyRefusal = refusal;
    evidence.busyWriterSpawns = spawns() - beforeBusy;
    await rpc("stop");
    evidence.passed = true;
    writeFileSync(path.join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, evidence: path.join(directory, "evidence.json") }));
  } finally {
    if (child.exitCode === null) {
      await rpc("shutdown").catch(() => child.kill("SIGTERM"));
    }
    for (const item of pending.values()) clearTimeout(item.timer);
  }
}

if (process.argv.includes("--fixture-provider")) fixtureProvider();
else if (process.argv.includes("--fixture-daemon")) await fixtureDaemon();
else await runCanary();
