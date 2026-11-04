import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { hashSync } from "bcryptjs";
import { createHostClient } from "@getpaseo/client/node";
import type { WorkspaceLayoutEntry } from "@getpaseo/protocol/workspace-layout";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { loadConfig } from "./config.js";
import { savePersistedConfig } from "./persisted-config.js";

let root: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-layout-wire-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
  vi.stubEnv("CODEX_HOME", path.join(root, "codex"));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

// Source-level real HTTP/WebSocket/SDK/auth/store proof. Relay encryption is
// separately bound by the route tests; this private loopback is not a live relay.
test("password admission protects actual layout RPCs; two authenticated clients share durable revisions after reconnect", async () => {
  const home = path.join(root, ".paseo");
  await mkdir(home);
  await writeFile(path.join(home, "server-id"), "srv_layout_fixture");
  const logs: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, next) {
        logs.push(chunk.toString());
        next();
      },
    }),
  );
  const keys = await loadOrCreateDaemonKeyPair(home, logger);
  const mode = {
    role: "authority" as const,
    authorityServerId: "srv_layout_fixture",
    authorityKeySha256: createHash("sha256").update(keys.publicKeyB64).digest("hex"),
    authorityId: randomUUID(),
    epoch: randomUUID(),
  };
  const password = "fixture-only-layout-service-password";
  const verifier = hashSync(password, 4);
  savePersistedConfig(home, {
    version: 1,
    workspaceLayout: mode,
    daemon: { auth: { password: verifier } },
  });
  const resolved = loadConfig(home, { env: { HOME: root, PASEO_NODE_ENV: "production" } });
  expect(resolved.workspaceLayout).toEqual(mode);
  expect(resolved.auth?.password).toBe(verifier);
  const fixture = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    workspaceLayout: resolved.workspaceLayout,
    auth: resolved.auth,
    pluginsEnabled: false,
    logger,
    daemonVersion: "0.15.0-impower",
  });
  cleanup.push(() => fixture.close());
  function client(secret?: string) {
    const suffix = secret === undefined ? "" : `?password=${encodeURIComponent(secret)}`;
    const value = createHostClient(`tcp://127.0.0.1:${fixture.port}${suffix}`, {
      clientId: randomUUID(),
      reconnect: { enabled: false },
      connectTimeoutMs: 2000,
    });
    cleanup.push(() => value.close());
    return value;
  }
  for (const secret of [undefined, "wrong-fixture-password"]) {
    const denied = client(secret);
    await expect(denied.connect()).rejects.toThrow();
    expect(denied.getLastServerInfoMessage()).toBeNull();
  }
  await expect(readFile(path.join(home, "workspace-layout.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  const a = client(password);
  const b = client(password);
  await a.connect();
  await b.connect();
  expect(a.getLastServerInfoMessage()).toMatchObject({
    version: "0.15.0-impower",
    workspaceLayout: mode,
  });
  const initial = (await a.initializeWorkspaceLayout(mode)).snapshot;
  const entry: WorkspaceLayoutEntry = {
    ref: { serverId: "srv_replica", workspaceId: "workspace" },
    projectId: "project",
    pinnedAt: null,
    superpinnedAt: null,
    parent: null,
    siblingOrder: 0,
    pinPlacement: null,
    archivedAt: null,
    revision: 0,
  };
  await a.commitWorkspaceLayout({
    requestId: "import",
    expected: initial.stamp,
    mutations: [
      {
        kind: "import-host",
        source: {
          serverId: "srv_replica",
          sourceSha256: "a".repeat(64),
          resolutionSha256: "b".repeat(64),
        },
        previousSourceSha256: null,
        entries: [entry],
      },
    ],
  });
  const imported = await a.getWorkspaceLayout();
  await a.commitWorkspaceLayout({
    requestId: "activate",
    expected: imported.stamp,
    mutations: [{ kind: "activate", requiredImports: imported.imports }],
  });
  const observation = b.observeWorkspaceLayout();
  cleanup.push(() => observation.release());
  const baseline = await observation.ready;
  const revisions: number[] = [];
  const stop = observation.subscribe({
    snapshot: (state) => revisions.push(state.stamp.revision),
    update: (message) => {
      if (message.type === "workspace.layout.changed")
        revisions.push(message.payload.snapshot.stamp.revision);
    },
  });
  cleanup.push(async () => stop());
  const at = "2026-11-04T12:00:00.000Z";
  const receipt = await a.commitWorkspaceLayout({
    requestId: "pin",
    expected: baseline.stamp,
    mutations: [
      { kind: "put", entry: { ...baseline.entries[0], pinnedAt: at, superpinnedAt: at } },
    ],
  });
  await expect.poll(() => revisions.includes(receipt.receipt.stamp.revision)).toBe(true);
  const canonical = await b.getWorkspaceLayout();
  expect(canonical.entries[0]).toMatchObject({ pinnedAt: at, superpinnedAt: at });
  expect(canonical.stamp.epoch).toBe(mode.epoch);
  await b.close();
  const reconnected = client(password);
  await reconnected.connect();
  expect(await reconnected.getWorkspaceLayout()).toEqual(canonical);
  const disk: { snapshot: unknown } = JSON.parse(
    await readFile(path.join(home, "workspace-layout.json"), "utf8"),
  );
  expect(disk.snapshot).toEqual(canonical);
  for (const line of logs) {
    expect(line).not.toContain(password);
    expect(line).not.toContain(verifier);
    expect(line).not.toContain("wrong-fixture-password");
  }
}, 30_000);
