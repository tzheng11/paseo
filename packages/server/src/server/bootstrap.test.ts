import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { expect, test, onTestFinished } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import {
  createIdleRuntimeCleanup,
  type RuntimeCleanupCandidate,
} from "./agent/idle-runtime-cleanup/index.js";
import { createTestLogger } from "../test-utils/test-logger.js";

import { fanOutReconciledWorkspaceUpdates, connectIdleRuntimeCleanupConfig } from "./bootstrap.js";

test("initializes one process transport for warmed native fetch without replacing constructors", async () => {
  const transportUrl = new URL("./http-transport.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createServer as createNetServer } from "node:net";
    import { channel } from "node:diagnostics_channel";
    import { getDefaultHighWaterMark } from "node:stream";
    const references = Object.fromEntries(
      ["fetch", "Request", "Response", "Headers", "FormData"].map(key => [key, globalThis[key]])
    );
    let finishInflight;
    const server = createServer(async (request, response) => {
      if (request.url === "/inflight") {
        response.writeHead(200, {"content-type":"application/json", "connection":"close"});
        response.write('{"fixture":');
        finishInflight = () => response.end("true}");
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.setHeader("connection", "close");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        method: request.method, header: request.headers["x-before-init"] ?? null,
        body: Buffer.concat(chunks).toString()
      }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = "http://127.0.0.1:" + server.address().port;
      await (await fetch(url)).json();
      const inflight = await references.fetch(url + "/inflight");
      const before = new Request(url, {
        method: "POST", headers: { "x-before-init": "retained" }, body: "native request body"
      });
      const { configureHttpTransport } = await import(${JSON.stringify(transportUrl)});
      const { Agent, getGlobalDispatcher } = await import("undici");
      configureHttpTransport();
      const dispatcher = getGlobalDispatcher();
      finishInflight();
      assert.deepEqual(await inflight.json(), {fixture:true});
      assert.ok(dispatcher instanceof Agent);
      configureHttpTransport();
      assert.equal(getGlobalDispatcher(), dispatcher);
      for (const [key, reference] of Object.entries(references)) assert.equal(globalThis[key], reference);
      const response = await references.fetch(before);
      assert.ok(response instanceof references.Response);
      assert.deepEqual(await response.json(), {
        method: "POST", header: "retained", body: "native request body"
      });
      // Gate on observed FIN, not a timer: the body must still be unread when it arrives.
      for (const framing of ["length", "eof", "truncated-length", "truncated-chunked"]) {
        const body = Buffer.alloc(getDefaultHighWaterMark(false), 0x61);
        let headers = framing === "truncated-chunked" ? "Transfer-Encoding: chunked\\r\\n" :
          framing === "eof" ? "" : "Content-Length: " + body.length * (framing === "truncated-length" ? 2 : 1) + "\\r\\n";
        const bytes = Buffer.concat([
          Buffer.from("HTTP/1.1 200 OK\\r\\n" + headers + "Connection: close\\r\\n\\r\\n"),
          ...(framing === "truncated-chunked" ? [Buffer.from(body.length.toString(16) + "\\r\\n")] : []), body
        ]);
        const sockets = new Set();
        const fixture = createNetServer(socket => {
          sockets.add(socket); socket.on("error", () => {});
          socket.once("close", () => sockets.delete(socket));
          socket.once("data", () => socket.end(bytes));
        });
        await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
        const port = fixture.address().port;
        let finish;
        const ended = new Promise(resolve => { finish = resolve; });
        const connected = channel("undici:client:connected");
        const onConnected = ({ socket, connectParams }) => {
          if (Number(connectParams.port) === port) socket.once("end", finish);
        };
        connected.subscribe(onConnected);
        try {
          const response = await references.fetch("http://127.0.0.1:" + port);
          await ended;
          if (framing.startsWith("truncated")) await assert.rejects(response.arrayBuffer());
          else assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
        } finally {
          connected.unsubscribe(onConnected);
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
        }
      }
      await dispatcher.close();
      process.stdout.write("native transport contract passed");
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: new URL("../..", import.meta.url),
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: "", NODE_USE_ENV_PROXY: "0" },
    },
  );
  expect(result.stdout).toBe("native transport contract passed");
});

test.each([
  ["proxy URL alone", "0", "", [], false, false],
  ["environment opt-in", "1", "", [], true, false],
  ["CLI opt-in", "0", "", ["--use-env-proxy"], true, false],
  ["CLI disables NODE_OPTIONS", "1", "--use-env-proxy", ["--no-use-env-proxy"], false, false],
  ["NODE_OPTIONS disables environment", "1", "--no-use-env-proxy", [], false, false],
  [
    "CLI overrides NODE_OPTIONS disable",
    "0",
    "--no-use-env-proxy",
    ["--use-env-proxy"],
    true,
    false,
  ],
  ["quoted unrelated option", "0", '--title="--use-env-proxy"', [], false, false],
  ["underscore and last flag", "0", "", ["--no-use-env-proxy", "--use_env_proxy"], true, false],
  ["NO_PROXY bypass", "1", "", [], true, true],
  ["runtime NO_PROXY change", "1", "", [], true, false],
] as const)(
  "preserves Node proxy routing: %s",
  async (name, envFlag, nodeOptions, flags, enabled, bypass) => {
    const sockets = new Set<Socket>();
    let proxyConnections = 0;
    let originRequests = 0;
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    };
    const origin = createHttpServer((_request, response) => {
      originRequests++;
      response.setHeader("connection", "close");
      response.end('{"fixture":true}');
    });
    origin.on("connection", track);
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("No origin address");
    const target = "127.0.0.1:" + address.port;
    const proxy = createHttpServer();
    proxy.on("connection", track);
    proxy.on("connect", (request, client, head) => {
      if (request.url !== target) throw new Error("Unexpected proxy destination");
      proxyConnections++;
      const upstream = connect(address.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("No proxy address");
    const proxyUrl = "http://127.0.0.1:" + proxyAddress.port;
    const transportUrl = new URL("./http-transport.ts", import.meta.url).href;
    const script = `
    import assert from "node:assert/strict";
    const url = ${JSON.stringify("http://" + target)};
    await (await fetch(url)).json();
    const { configureHttpTransport, createHttpDispatcher } = await import(${JSON.stringify(transportUrl)});
    configureHttpTransport();
    assert.deepEqual(await (await fetch(url)).json(), {fixture:true});
    // A model download owns a separate dispatcher from this same factory.
    const {fetch: explicitFetch, getGlobalDispatcher} = await import("undici");
    if (${JSON.stringify("runtime NO_PROXY change")} === ${JSON.stringify(name)}) {
      process.env.NO_PROXY = new URL(url).host; process.env.no_proxy = new URL(url).host;
    }
    const owned = createHttpDispatcher();
    try { assert.deepEqual(await (await explicitFetch(url, {dispatcher:owned})).json(), {fixture:true}); }
    finally { await owned.destroy(); }
    assert.deepEqual(await (await fetch(url)).json(), {fixture:true});
    await getGlobalDispatcher().close();
    process.stdout.write("proxy routing contract passed");
  `;
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [...flags, "--import", "tsx", "--input-type=module", "--eval", script],
        {
          cwd: new URL("../..", import.meta.url),
          timeout: 15_000,
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            NODE_USE_ENV_PROXY: envFlag,
            HTTP_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            https_proxy: proxyUrl,
            NO_PROXY: bypass ? target : "",
            no_proxy: bypass ? target : "",
          },
        },
      );
      expect(result.stdout).toBe("proxy routing contract passed");
      expect(originRequests).toBe(4);
      let expectedProxyConnections = 0;
      if (enabled && !bypass) expectedProxyConnections = name === "runtime NO_PROXY change" ? 2 : 4;
      expect(proxyConnections).toBe(expectedProxyConnections);
    } catch (error) {
      console.error({ proxyConnections, originRequests });
      throw error;
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [origin, proxy].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
        ),
      );
    }
  },
);

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});

// Exercise bootstrap's actual live-config binding with the real collector and store.

function liveCleanupHost() {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-live-cleanup-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ version: 1 }));
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({
      relay: { enabled: true },
      mcp: { injectIntoAgents: false },
      idleRuntimeCleanup: true,
    }),
    undefined,
    {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: MutableDaemonConfigSchema.parse({
            relay: { enabled: true },
            mcp: { injectIntoAgents: false },
            idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup ?? true,
          }),
          overrideControlledPaths: [],
        }),
      },
    },
  );
  let minutes = 61;
  let closed = false;
  let protectedCaller = false;
  const runtime: RuntimeCleanupCandidate = {
    identity: {},
    agentId: "agent",
    provider: "test",
    sessionId: "session",
    parentAgentId: undefined,
    lastActivityAt: 0,
    isEligible: () => !closed,
    closeIfEligible: async (eligible) => {
      if (!eligible()) return false;
      closed = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    now: () => minutes * 60_000,
    runtimes: () => [runtime],
    isProtected: () => protectedCaller,
    logger: createTestLogger(),
    schedule: () => () => {},
  });
  const unsubscribe = connectIdleRuntimeCleanupConfig(store, cleanup);
  onTestFinished(async () => {
    unsubscribe();
    await cleanup.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    store,
    cleanup,
    unsubscribe,
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    sweep: (at = minutes) => {
      minutes = at;
      return cleanup.sweep();
    },
  };
}

test("bootstrap's host toggle prevents collection live, persists, and leaves other hosts enabled", async () => {
  const host = liveCleanupHost();
  const other = liveCleanupHost();
  await host.store.patch({ idleRuntimeCleanup: false });
  expect(loadPersistedConfig(host.home).agents?.idleRuntimeCleanup).toBe(false);
  expect((await host.sweep()).collected).toEqual([]);
  expect((await other.sweep()).collected).toHaveLength(1);
  await host.store.patch({ idleRuntimeCleanup: true });
  host.protect(true);
  expect((await host.sweep()).collected).toEqual([]);
  host.protect(false);
  expect((await host.sweep(62)).collected).toEqual([]);
  expect((await host.sweep(122)).collected).toHaveLength(1);
});

test("bootstrap's config-file reload binding disables and enables eligible collection live", async () => {
  const host = liveCleanupHost();
  for (const enabled of [false, true]) {
    writeFileSync(
      path.join(host.home, "config.json"),
      JSON.stringify({ version: 1, agents: { idleRuntimeCleanup: enabled } }),
    );
    expect(await host.store.reload()).toEqual({
      appliedPaths: ["agents.idleRuntimeCleanup"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect((await host.sweep()).collected).toHaveLength(enabled ? 1 : 0);
  }
});

test.each([false, true])(
  "failed config apply restores prior idle cleanup behavior (previous: %s)",
  async (previous) => {
    const host = liveCleanupHost();
    await host.store.patch({ idleRuntimeCleanup: previous });
    const persistedBefore = loadPersistedConfig(host.home);
    const refuse = host.store.onApply(() => {
      throw new Error("Another live owner refused");
    });
    await expect(host.store.patch({ idleRuntimeCleanup: !previous })).rejects.toThrow(
      "Another live owner refused",
    );
    expect(host.store.get().idleRuntimeCleanup).toBe(previous);
    expect(loadPersistedConfig(host.home)).toEqual(persistedBefore);
    expect((await host.sweep()).collected).toHaveLength(previous ? 1 : 0);
    refuse();
  },
);

test("disposing bootstrap's binding stops configuration delivery", async () => {
  const host = liveCleanupHost();
  host.unsubscribe();
  await host.store.patch({ idleRuntimeCleanup: false });
  expect((await host.sweep()).collected).toHaveLength(1);
});
