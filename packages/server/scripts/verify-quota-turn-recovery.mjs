#!/usr/bin/env node
// Compiled CLI -> daemon -> actual Claude/Codex adapters with typed native fixtures. No models/auth.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixtureCodexProvider() {
  const journal = argument("--journal");
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let threadId;
  const notify = (method, params) => send({ method, params });
  process.on("message", (message) => {
    if (message.action !== "background" || message.threadId !== threadId) return;
    notify("codex/event/exec_command_begin", {
      id: threadId,
      msg: { type: "exec_command_begin", call_id: "fixture-local-job", command: ["sleep", "30"] },
    });
    notify("codex/event/exec_command_end", {
      id: threadId,
      msg: {
        type: "exec_command_end",
        call_id: "fixture-local-job",
        command: ["sleep", "30"],
        aggregated_output: "Process running with session id 4242",
        exit_code: 0,
      },
    });
  });
  process.on("disconnect", () => process.exit(0));
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
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
          threadId = randomUUID();
          result = { thread: { id: threadId } };
          break;
        case "thread/resume":
          threadId = request.params.threadId;
          result = { thread: { id: threadId } };
          break;
        case "thread/read":
          result = { thread: { id: threadId, historyMode: "paginated" } };
          break;
        case "thread/turns/list":
        case "thread/items/list":
          result = { data: [], nextCursor: null };
          break;
        case "turn/start": {
          const turnId = randomUUID();
          const previous = readFileSync(journal, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((entry) => JSON.parse(entry))
            .filter((entry) => entry.kind === "prompt" && entry.sessionId === threadId);
          const text = request.params.input.map((item) => item.text ?? "").join("\n");
          appendFileSync(
            journal,
            `${JSON.stringify({ kind: "prompt", sessionId: threadId, text, turnId })}\n`,
          );
          result = { turn: { id: turnId } };
          setTimeout(() => {
            notify("turn/started", { threadId, turn: { id: turnId } });
            notify("item/completed", {
              threadId,
              turnId,
              item: {
                type: "agentMessage",
                id: randomUUID(),
                text: previous.length ? "Continued preserved task" : "Usage limit reached",
              },
            });
            notify("turn/completed", {
              threadId,
              turn: {
                id: turnId,
                status: previous.length ? "completed" : "failed",
                error: previous.length
                  ? null
                  : { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
              },
            });
          }, 0);
          break;
        }
        default:
          break;
      }
      send({ id: request.id, result });
    })
    .on("close", () => process.exit(0));
}

async function fixtureDaemon() {
  const home = argument("--home");
  const providerName = argument("--provider", "claude");
  assert.ok(["claude", "codex"].includes(providerName));
  const port = Number(argument("--port", "0"));
  assert.notEqual(port, 6767);
  const require = createRequire(path.join(runtime, "packages/server/package.json"));
  const logger = require("pino")({ level: "silent" });
  const { createPaseoDaemon } = await load("packages/server/dist/server/server/bootstrap.js");
  const { BuiltinPluginLoader } = await load(
    "packages/server/dist/server/server/plugins/builtin/index.js",
  );
  const { ClaudeAgentClient } = await load(
    "packages/server/dist/server/server/agent/providers/claude/agent.js",
  );
  const states = new Map();
  const queries = new Map();
  const journal = argument("--journal");
  const queryFactory = ({ prompt, options }) => {
    const sessionId = options.resume ?? randomUUID();
    const state = states.get(sessionId) ?? { quota: true, prompts: [] };
    states.set(sessionId, state);
    const queue = [];
    let wake;
    let closed = false;
    const push = (message) => {
      queue.push(message);
      wake?.();
      wake = undefined;
    };
    const query = {
      async next() {
        while (!queue.length) {
          if (closed) return { done: true };
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
        return queue.length ? { done: false, value: queue.shift() } : { done: true };
      },
      async return() {
        closed = true;
        wake?.();
        return { done: true };
      },
      close() {
        closed = true;
        wake?.();
      },
      async interrupt() {},
      async setPermissionMode() {},
      async setModel() {},
      async getContextUsage() {},
      async supportedModels() {
        return [{ value: "fixture-model", displayName: "Fixture" }];
      },
      async supportedCommands() {
        return [];
      },
      async rewindFiles() {
        return { canRewind: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      push,
    };
    queries.set(sessionId, query);
    void (async () => {
      for await (const message of prompt) {
        const text =
          typeof message.message?.content === "string"
            ? message.message.content
            : JSON.stringify(message.message?.content);
        state.prompts.push(text);
        appendFileSync(journal, `${JSON.stringify({ sessionId, text, uuid: message.uuid })}\n`);
        const base = { session_id: sessionId, parent_tool_use_id: null };
        push({ type: "command_lifecycle", command_uuid: message.uuid, state: "started", ...base });
        push({
          type: "system",
          subtype: "init",
          model: "fixture-model",
          permissionMode: "default",
          ...base,
        });
        const quota = state.quota;
        push({
          type: "assistant",
          ...(quota ? { error: "rate_limit" } : {}),
          message: {
            content: [
              { type: "text", text: quota ? "Session limit reached" : "Continued preserved task" },
            ],
          },
          uuid: randomUUID(),
          ...base,
        });
        push({
          type: "result",
          subtype: "success",
          is_error: quota,
          result: quota ? "Session limit reached" : "Continued preserved task",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          uuid: randomUUID(),
          ...base,
        });
      }
    })().catch((error) => {
      if (!closed) throw error;
    });
    return query;
  };
  let provider;
  const codexChildren = [];
  if (providerName === "claude") {
    provider = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/fixture/never-executed-claude",
    });
  } else {
    const { CodexAppServerAgentClient } = await load(
      "packages/server/dist/server/server/agent/providers/codex-app-server-agent.js",
    );
    provider = new CodexAppServerAgentClient(logger);
    provider.goalsEnabledPromise = Promise.resolve(false);
    provider.autoReviewEnabledPromise = Promise.resolve(false);
    provider.spawnAppServer = async () => {
      const child = spawn(process.execPath, [script, "--fixture-codex", "--journal", journal], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: process.env,
      });
      codexChildren.push(child);
      return child;
    };
  }
  let holdResume = false;
  const originalResume = provider.resumeSession.bind(provider);
  provider.resumeSession = async (...args) => {
    if (holdResume) await new Promise(() => {});
    return originalResume(...args);
  };
  provider.isAvailable = async () => true;
  provider.fetchCatalog = async () => ({
    provider: providerName,
    models: [{ provider: providerName, id: "fixture-model", label: "Fixture", isDefault: true }],
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
      agentClients: { [providerName]: provider },
      pluginsEnabled: false,
      voiceLlmProvider: null,
    },
    logger,
    { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
  );
  await daemon.start();
  const snapshot = (id) => {
    const agent = daemon.agentManager.getAgent(id);
    const sessionId = agent?.persistence?.sessionId;
    return {
      agentId: id,
      sessionId,
      lifecycle: agent?.lifecycle,
      checkpoint: agent?.quotaTurnCheckpoint,
      prompts:
        providerName === "claude"
          ? (states.get(sessionId)?.prompts ?? [])
          : readFileSync(journal, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .filter((entry) => entry.kind === "prompt" && entry.sessionId === sessionId)
              .map((entry) => entry.text),
      epoch: daemon.agentManager.getTimelineEpoch(id),
      history: daemon.agentManager.getTimeline(id),
    };
  };
  process.on("message", async (request) => {
    try {
      const { action, agentId } = request;
      let value;
      if (action === "create-quota") {
        const agent = await daemon.agentManager.createAgent(
          { provider: providerName, cwd: home, model: "fixture-model" },
          undefined,
          { workspaceId: undefined },
        );
        await daemon.agentManager
          .runAgent(agent.id, "Original tool-producing fixture task; never replay this exact input")
          .then(
            () => {
              throw new Error("Quota fixture unexpectedly completed");
            },
            () => {},
          );
        for (
          let n = 0;
          n < 100 && !daemon.agentManager.getAgent(agent.id)?.quotaTurnCheckpoint;
          n++
        )
          await pause(5);
        value = snapshot(agent.id);
        assert.ok(value.checkpoint, "Actual provider adapter must arm typed checkpoint");
        if (states.has(value.sessionId)) states.get(value.sessionId).quota = false;
      }
      if (action === "snapshot") value = snapshot(agentId);
      if (action === "hold-resume") {
        holdResume = true;
        value = {};
      }
      if (action === "newer-user") {
        await daemon.agentManager.runAgent(agentId, "A newer user request wins");
        value = snapshot(agentId);
      }
      if (action === "background") {
        const sessionId = daemon.agentManager.getAgent(agentId).persistence.sessionId;
        if (providerName === "codex") {
          codexChildren
            .filter((child) => child.connected)
            .forEach((child) => child.send({ action: "background", threadId: sessionId }));
        } else {
          queries.get(sessionId).push({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: "local-job",
                task_type: "local_bash",
                description: "Owned fixture background work",
              },
            ],
            uuid: randomUUID(),
            session_id: sessionId,
          });
        }
        for (
          let n = 0;
          n < 100 && !daemon.agentManager.getAgent(agentId)?.session.hasActiveBackgroundTasks();
          n++
        )
          await pause(5);
        assert.equal(
          daemon.agentManager.getAgent(agentId)?.session.hasActiveBackgroundTasks(),
          true,
        );
        value = snapshot(agentId);
      }
      if (action === "shutdown") {
        await daemon.stop();
        process.send({ id: request.id, value: {} });
        process.exit(0);
      }
      process.send({ id: request.id, value });
    } catch (error) {
      process.send({ id: request.id, error: error.stack });
    }
  });
  process.send({ ready: true, port: daemon.getListenTarget().port });
}

async function waitOwnedExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(milliseconds) });
    return true;
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  }
}
async function stopOwnedChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  if (await waitOwnedExit(child, 2500)) return;
  child.kill("SIGKILL");
  assert.equal(
    await waitOwnedExit(child, 2500),
    true,
    "Owned fixture child must exit within cleanup budget",
  );
}
function assertReceipt(receipt, agentId, operationId, change) {
  assert.equal(receipt.agentId, agentId);
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.credentialGeneration, change?.credentialGeneration);
  assert.equal(receipt.credentialChangedAt, change?.credentialChangedAt);
  if (change && receipt.status === "completed") {
    assert.ok(["submitted", "not_needed", "refused"].includes(receipt.continuation?.status));
    if (receipt.continuation.status === "submitted") {
      assert.ok(receipt.continuation.failedTurnId);
      assert.match(receipt.continuation.messageId, /^quota-recovery-[a-f0-9]{64}$/);
    }
  }
}

async function runCanary() {
  const providerName = argument("--provider", "claude");
  assert.ok(["claude", "codex"].includes(providerName));
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-quota-recovery-canary-"));
  const home = path.join(directory, "home");
  mkdirSync(path.join(home, "static"), { recursive: true });
  const journal = path.join(directory, "prompts.jsonl");
  writeFileSync(journal, "");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/PASEO|CODEX|CLAUDE|ANTHROPIC|OPENAI|TOKEN|SECRET|PASSWORD|API_KEY/.test(key),
    ),
  );
  Object.assign(env, {
    HOME: home,
    PASEO_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    CODEX_HOME: path.join(home, "codex"),
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    NODE_OPTIONS: "",
  });
  const deadline = Date.now() + 150_000;
  const budget = (limit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Quota canary work deadline exceeded");
    return Math.min(limit, remaining);
  };
  const pending = new Map();
  let child;
  const launch = () => {
    child = spawn(
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
        "--provider",
        providerName,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"], env },
    );
    const current = child;
    current.stdout.on("data", (data) => appendFileSync(path.join(directory, "daemon.log"), data));
    current.stderr.on("data", (data) => appendFileSync(path.join(directory, "daemon.log"), data));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture startup timeout")), budget(30_000));
      current.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Fixture exited ${code}: ${directory}/daemon.log`));
        for (const item of pending.values()) item.reject(new Error("Fixture exited"));
      });
      current.on("message", (message) => {
        if (message.ready) {
          clearTimeout(timer);
          resolve(message);
        }
        const item = pending.get(message.id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(message.id);
          if (message.error) item.reject(new Error(message.error));
          else item.resolve(message.value);
        }
      });
    });
  };
  const rpc = (action, agentId) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => reject(new Error(`IPC timeout ${action}`)), budget(20_000));
      pending.set(id, { resolve, reject, timer });
      child.send({ id, action, agentId });
    });
  const exec = promisify(execFile);
  let port;
  const cli = async (args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [
            path.join(runtime, "packages/cli/bin/paseo"),
            ...args,
            "--host",
            `127.0.0.1:${port}`,
            "--json",
          ],
          { env, timeout: budget(20_000), maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    );
  const reload = async (agentId, change, operationId = randomUUID()) => {
    const args = [
      "agent",
      "reload",
      agentId,
      "--only-if-idle",
      "--preserve-history",
      "--operation-id",
      operationId,
    ];
    if (change)
      args.push(
        "--credential-generation",
        change.credentialGeneration,
        "--credential-changed-at",
        change.credentialChangedAt,
      );
    const admission = await cli(args);
    assertReceipt(admission, agentId, operationId, change);
    for (let n = 0; n < 100; n++) {
      const result = await cli(["agent", "reload-status", operationId]);
      assertReceipt(result, agentId, operationId, change);
      if (result.status !== "pending") return { result, args };
      await pause(20);
    }
    throw new Error("Operation did not finish");
  };
  const hashes = Object.fromEntries(
    [
      "packages/server/dist/server/server/agent/agent-manager.js",
      "packages/server/dist/server/server/agent/providers/claude/agent.js",
      "packages/server/dist/server/server/agent/quota-turn-recovery.js",
      "packages/cli/dist/commands/agent/reload.js",
    ].map((file) => [file, digest(readFileSync(path.join(runtime, file)))]),
  );
  const evidence = {
    runtime,
    directory,
    provider: providerName,
    modelCalls: 0,
    artifactHashes: hashes,
  };
  try {
    port = (await launch()).port;
    evidence.port = port;
    const failed = await rpc("create-quota");
    const v1 = await reload(failed.agentId);
    assert.equal(v1.result.status, "completed");
    const afterV1 = await rpc("snapshot", failed.agentId);
    assert.equal(afterV1.prompts.length, 1);
    assert.deepEqual(afterV1.checkpoint, failed.checkpoint);
    const old = await reload(failed.agentId, {
      credentialGeneration: "old",
      credentialChangedAt: failed.checkpoint.failedAt,
    });
    assert.equal(old.result.continuation.status, "not_needed");
    await pause(5);
    const change = {
      credentialGeneration: "confirmed-B",
      credentialChangedAt: new Date().toISOString(),
    };
    const recovered = await reload(failed.agentId, change);
    assert.equal(recovered.result.status, "completed");
    assert.equal(recovered.result.continuation.status, "submitted");
    assert.equal(recovered.result.continuation.failedTurnId, failed.checkpoint.turnId);
    const after = await rpc("snapshot", failed.agentId);
    assert.equal(after.prompts.length, 2);
    assert.equal(after.sessionId, failed.sessionId);
    assert.equal(after.epoch, failed.epoch);
    assert.deepEqual(after.history.slice(0, failed.history.length), failed.history);
    assert.match(after.prompts[1], /Automatic quota recovery/);
    assert.doesNotMatch(after.prompts[1], /Original tool-producing fixture task/);
    assert.deepEqual(await cli(recovered.args), recovered.result);
    assert.equal((await rpc("snapshot", failed.agentId)).prompts.length, 2);
    evidence.recovered = {
      operation: recovered.result,
      promptCount: after.prompts.length,
      sameSession: true,
      sameEpoch: true,
      retainedHistory: true,
      uuidReplayStable: true,
    };
    const newer = await rpc("create-quota");
    await rpc("newer-user", newer.agentId);
    const newerResult = await reload(newer.agentId, {
      credentialGeneration: "newer-C",
      credentialChangedAt: new Date().toISOString(),
    });
    assert.equal(newerResult.result.continuation.status, "not_needed");
    assert.equal((await rpc("snapshot", newer.agentId)).prompts.length, 2);
    evidence.newerUser = newerResult.result;
    const busy = await rpc("create-quota");
    await rpc("background", busy.agentId);
    const busyResult = await reload(busy.agentId, {
      credentialGeneration: "busy-D",
      credentialChangedAt: new Date().toISOString(),
    });
    assert.equal(busyResult.result.status, "refused");
    assert.equal(busyResult.result.reasonCode, "AGENT_RELOAD_BUSY");
    assert.equal((await rpc("snapshot", busy.agentId)).prompts.length, 1);
    evidence.nativeBackground = busyResult.result;
    // Crash an OWNED fixture daemon only after the durable V2 intent is admitted,
    // while its provider replacement is deliberately held before any continuation.
    const crash = await rpc("create-quota");
    await rpc("hold-resume");
    const crashOperationId = randomUUID();
    const crashChange = {
      credentialGeneration: "crash-E",
      credentialChangedAt: new Date().toISOString(),
    };
    const crashArgs = [
      "agent",
      "reload",
      crash.agentId,
      "--only-if-idle",
      "--preserve-history",
      "--operation-id",
      crashOperationId,
      "--credential-generation",
      crashChange.credentialGeneration,
      "--credential-changed-at",
      crashChange.credentialChangedAt,
    ];
    const admitted = await cli(crashArgs);
    assertReceipt(admitted, crash.agentId, crashOperationId, crashChange);
    assert.equal(admitted.status, "pending");
    const beforeCrashPrompts = readFileSync(journal, "utf8");
    await stopOwnedChild(child, "SIGKILL");
    port = (await launch()).port;
    const unknown = await cli(["agent", "reload-status", crashOperationId]);
    assertReceipt(unknown, crash.agentId, crashOperationId, crashChange);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.reasonCode, "DAEMON_RESTARTED");
    assert.equal(unknown.credentialGeneration, crashChange.credentialGeneration);
    assert.equal(unknown.credentialChangedAt, crashChange.credentialChangedAt);
    assert.deepEqual(await cli(crashArgs), unknown);
    assert.equal(
      readFileSync(journal, "utf8"),
      beforeCrashPrompts,
      "Restart/replay must not send a second input",
    );
    evidence.restartPending = { operation: unknown, sameIntentStable: true, additionalPrompts: 0 };
    evidence.passed = true;
    const file = path.join(directory, "evidence.json");
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, evidence: file }));
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null)
        await rpc("shutdown").catch(() => undefined);
    } finally {
      await stopOwnedChild(child);
      for (const item of pending.values()) clearTimeout(item.timer);
    }
  }
}
if (process.argv.includes("--fixture-codex")) fixtureCodexProvider();
else if (process.argv.includes("--fixture-daemon")) await fixtureDaemon();
else await runCanary();
