import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { hashSync } from "bcryptjs";
import { createHostClient } from "@getpaseo/client/node";
import type { WorkspaceLayoutEntry } from "@getpaseo/protocol/workspace-layout";
import {
  emptyWorkspaceNavigationPreferences,
  qualifyLegacyWorkspaceLayoutEntries,
} from "@getpaseo/protocol/workspace-layout";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { loadConfig } from "./config.js";
import { savePersistedConfig } from "./persisted-config.js";
import { CanonicalSidebarLayout } from "../../../app/src/stores/canonical-sidebar-layout.js";
import { canonicalWorkspaceDrop } from "../../../app/src/components/sidebar/workspace-tree/canonical-drop.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";

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
    siblingOrder: null,
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
      {
        kind: "import-host",
        previousSourceSha256: null,
        source: {
          serverId: "srv_other",
          sourceSha256: "c".repeat(64),
          resolutionSha256: "d".repeat(64),
        },
        entries: [{ ...entry, ref: { serverId: "srv_other", workspaceId: "workspace" } }],
      },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "0".repeat(64) },
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
  expect(await b.getWorkspaceLayoutReceipt("pin")).toEqual(receipt.receipt);
  expect(await b.getWorkspaceLayoutReceipt("never-dispatched")).toBeNull();
  await expect.poll(() => revisions.includes(receipt.receipt.stamp.revision)).toBe(true);
  const pinned = await b.getWorkspaceLayout();
  await a.commitWorkspaceLayout({
    requestId: "shared-navigation",
    expected: pinned.stamp,
    mutations: [
      {
        kind: "put-navigation",
        expectedRevision: pinned.navigation!.revision,
        preferences: {
          ...pinned.navigation!.preferences,
          projectOrder: ["shared-view"],
          workspaceOrderByProject: { "shared-view": ["srv_replica:workspace"] },
          pinnedWorkspaceSortMode: "alphabetical",
        },
      },
    ],
  });
  const canonical = await b.getWorkspaceLayout();
  expect(canonical.entries[0]).toMatchObject({ pinnedAt: at, superpinnedAt: at });
  expect(canonical.navigation?.preferences).toMatchObject({
    projectOrder: ["shared-view"],
    workspaceOrderByProject: { "shared-view": ["srv_replica:workspace"] },
    pinnedWorkspaceSortMode: "alphabetical",
  });
  expect(canonical.stamp.epoch).toBe(mode.epoch);
  await b.close();
  const reconnected = client(password);
  await reconnected.connect();
  expect(await reconnected.getWorkspaceLayout()).toEqual(canonical);
  const disk: { snapshot: unknown } = JSON.parse(
    await readFile(path.join(home, "workspace-layout.json"), "utf8"),
  );
  expect(disk.snapshot).toEqual(canonical);
  let browserReplica: string | null = null;
  const dependencies = {
    read: async () => browserReplica,
    write: async (bytes: string) => {
      browserReplica = bytes;
    },
    hash: async (bytes: string) => createHash("sha256").update(bytes).digest("hex"),
    requestId: randomUUID,
    changed: () => {},
  };
  const browser = new CanonicalSidebarLayout(dependencies);
  const detach = await browser.attach("private-hub-fixture", a, mode);
  cleanup.push(() => browser.close());
  await expect.poll(() => browser.state().writable).toBe(true);
  await browser.update((preferences) => ({ ...preferences, pinnedWorkspaceSortMode: "activity" }));
  const afterBrowser = await reconnected.getWorkspaceLayout();
  expect(afterBrowser.navigation?.preferences.pinnedWorkspaceSortMode).toBe("activity");
  expect(afterBrowser.stamp.revision).toBe(canonical.stamp.revision + 1);
  expect(browser.state().snapshot).toEqual(afterBrowser);
  await browser.mutate((snapshot) =>
    canonicalWorkspaceDrop({
      snapshot,
      now: at,
      catalog: [
        {
          workspaceKey: "srv_replica:workspace",
          projectViewKey: "shared-view",
          sidebarSection: "superpinned",
        },
        { workspaceKey: "srv_other:workspace", projectViewKey: "shared-view" },
      ],
      projectOrder: ["srv_replica:workspace", "srv_other:workspace"],
      drop: {
        workspaceKey: "srv_replica:workspace",
        targetWorkspaceKey: "srv_other:workspace",
        position: "after",
        parentWorkspaceId: null,
        beforeWorkspaceId: null,
      },
    }),
  );
  const afterDrop = await reconnected.getWorkspaceLayout();
  expect(afterDrop.stamp.revision).toBe(afterBrowser.stamp.revision + 1);
  expect(afterDrop.entries[0]).toMatchObject({ pinnedAt: null, superpinnedAt: null });
  expect(afterDrop.navigation?.preferences.workspaceOrderByProject["shared-view"]).toEqual([
    "srv_other:workspace",
    "srv_replica:workspace",
  ]);
  detach();
  await browser.close();
  const freshBrowser = new CanonicalSidebarLayout(dependencies);
  await freshBrowser.ready;
  expect(freshBrowser.state()).toMatchObject({
    enabled: true,
    writable: false,
    pending: false,
    snapshot: afterDrop,
  });
  for (const line of logs) {
    expect(line).not.toContain(password);
    expect(line).not.toContain(verifier);
    expect(line).not.toContain("wrong-fixture-password");
  }
}, 30_000);

test("derived authority fences legacy native writers before effects while the current SDK creates and pins a fresh leaf", async () => {
  const home = path.join(root, ".paseo");
  await mkdir(home);
  const serverId = "srv_derived_fixture";
  await writeFile(path.join(home, "server-id"), serverId);
  const logger = pino({ level: "silent" });
  const keys = await loadOrCreateDaemonKeyPair(home, logger);
  const mode = {
    role: "authority" as const,
    semanticsVersion: 2 as const,
    authorityServerId: serverId,
    authorityKeySha256: createHash("sha256").update(keys.publicKeyB64).digest("hex"),
    authorityId: randomUUID(),
    epoch: randomUUID(),
  };
  const password = "fixture-derived-only";
  const fixture = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    workspaceLayout: mode,
    auth: { password: hashSync(password, 4) },
    pluginsEnabled: false,
    logger,
  });
  cleanup.push(() => fixture.close());
  const client = createHostClient(`tcp://127.0.0.1:${fixture.port}?password=${password}`, {
    clientId: randomUUID(),
    reconnect: { enabled: false },
  });
  cleanup.push(() => client.close());
  await client.connect();
  expect(client.getLastServerInfoMessage()?.features?.workspaceLayoutDerivedSections).toBe(true);
  const initial = (await client.initializeWorkspaceLayout(mode)).snapshot;
  await client.commitWorkspaceLayout({
    requestId: "derived-import",
    writerVersion: 2,
    expected: initial.stamp,
    mutations: [
      {
        kind: "import-host",
        previousSourceSha256: null,
        source: { serverId, sourceSha256: "a".repeat(64), resolutionSha256: "b".repeat(64) },
        entries: qualifyLegacyWorkspaceLayoutEntries([]),
      },
      { kind: "declare-unknown-owner", serverId: "offline-owner" },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "c".repeat(64) },
      },
    ],
  });
  const imported = await client.getWorkspaceLayout();
  await client.commitWorkspaceLayout({
    requestId: "derived-activate",
    writerVersion: 2,
    expected: imported.stamp,
    mutations: [
      {
        kind: "activate",
        requiredImports: imported.imports,
        requiredOwnerDomains: imported.ownerDomains,
      },
    ],
  });
  const baseline = await client.getWorkspaceLayout();
  const legacy = client as unknown as {
    sendRequest(options: {
      requestId: string;
      message: unknown;
      select: (msg: unknown) => unknown;
    }): Promise<unknown>;
  };
  // Emulate an old SDK's wire envelope: it neither understands nor sends the new field.
  const advertised = client.getLastServerInfoMessage()!;
  const derivedMode = advertised.workspaceLayout!;
  advertised.workspaceLayout = { ...derivedMode, semanticsVersion: undefined };
  for (const type of [
    "workspace.pin.set.request",
    "workspace.move.request",
    "workspace.create.request",
    "workspace.recovery.restore.request",
  ]) {
    await expect(
      legacy.sendRequest({
        requestId: `legacy-${type}`,
        message: {
          type,
          requestId: `legacy-${type}`,
          ...(type === "workspace.create.request" ? {} : { workspaceId: "missing" }),
          pinned: true,
          parentWorkspaceId: null,
          source: { kind: "directory", path: root },
        },
        select: () => null,
      }),
    ).rejects.toMatchObject({ code: "writer_version_required" });
  }
  advertised.workspaceLayout = derivedMode;
  expect((await client.getWorkspaceLayout()).stamp).toEqual(baseline.stamp);
  expect(client.getLastServerInfoMessage()?.features?.workspaceRetirementOperations).toBe(true);
  const operationRoot = path.join(root, "operation-target");
  await mkdir(operationRoot, { recursive: true });
  const operationTarget = await client.createWorkspace({
    source: { kind: "directory", path: operationRoot },
  });
  const operationWorkspaceId = operationTarget.workspace!.id;
  const heldId = randomUUID();
  await client.setWorkspacePinned(operationWorkspaceId, true);
  expect(
    (await client.archiveWorkspace(operationWorkspaceId, { operationId: heldId })).error,
  ).toContain("retirement_native_hold");
  expect(await client.getWorkspaceRetirementStatus(heldId)).toMatchObject({
    operationId: heldId,
    workspaceId: operationWorkspaceId,
    state: "refused",
    terminal: true,
  });
  await client.setWorkspacePinned(operationWorkspaceId, false);
  expect(
    (await client.archiveWorkspace(operationWorkspaceId, { operationId: heldId })).error,
  ).toContain("retirement_native_hold");
  const completedId = randomUUID();
  const completed = await client.archiveWorkspace(operationWorkspaceId, {
    operationId: completedId,
  });
  expect(completed.error).toBeNull();
  expect(completed.retirement).toMatchObject({ operationId: completedId, state: "complete" });
  const readClient = createHostClient(`tcp://127.0.0.1:${fixture.port}?password=${password}`, {
    clientId: randomUUID(),
    reconnect: { enabled: false },
    sessionPermissions: ["workspace.read"],
  });
  cleanup.push(() => readClient.close());
  await readClient.connect();
  expect(await readClient.getWorkspaceRetirementStatus(completedId)).toMatchObject({
    state: "complete",
    result: { retirement: completed.retirement, removedDirectory: false, slotKept: true },
  });
  expect(await readClient.getWorkspaceRetirementStatus(randomUUID())).toBeNull();
  await expect(
    readClient.verifyWorkspaceRetirementBinding({
      operationId: completedId,
      workspaceId: operationWorkspaceId,
      backingGeneration: "a".repeat(64),
      worktreePath: operationRoot,
      teardownCwd: operationRoot,
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(
    await client.verifyWorkspaceRetirementBinding({
      operationId: completedId,
      workspaceId: operationWorkspaceId,
      backingGeneration: "a".repeat(64),
      worktreePath: operationRoot,
      teardownCwd: operationRoot,
    }),
  ).toEqual({ valid: false, code: "retirement_hook_not_active" });
  const created = await client.createWorkspace({ source: { kind: "directory", path: root } });
  expect(created.workspace).not.toBeNull();
  const id = created.workspace!.id;
  await client.setWorkspacePinned(id, true);
  expect(
    (await client.getWorkspaceLayout()).entries.find((e) => e.ref.workspaceId === id),
  ).toMatchObject({ sectionIntent: { mode: "explicit" }, pinnedAt: expect.any(String) });
  expect(client.getLastServerInfoMessage()?.features?.workspaceLayoutRetirement).toBe(true);
  expect((await client.archiveWorkspace(id)).error).toContain("retirement_native_hold");
  await client.setWorkspacePinned(id, false);
  const archived = await client.archiveWorkspace(id);
  expect(archived.error).toBeNull();
  expect(archived.retirement?.state).toBe("complete");
  expect(archived.removedDirectory).toBe(false);
  expect(archived.slotKept).toBe(true);
  const replacement = await client.createWorkspace({ source: { kind: "directory", path: root } });
  expect(replacement.workspace?.id).not.toBe(id);
  expect(replacement.workspace).not.toBeNull();
  const replay = await client.archiveWorkspace(id);
  expect(replay.retirement).toEqual(archived.retirement);
  const final = await client.getWorkspaceLayout();
  expect(final.entries.find((entry) => entry.ref.workspaceId === id)?.archivedAt).toBe(
    archived.archivedAt,
  );
  expect(
    final.entries.find((entry) => entry.ref.workspaceId === replacement.workspace!.id)?.archivedAt,
  ).toBeNull();
  expect(
    JSON.parse(await readFile(path.join(home, "workspace-layout-mode.json"), "utf8")).schemaVersion,
  ).toBe(3);
  await expect(
    legacy.sendRequest({
      requestId: "old-retirement-reader",
      message: { type: "workspace.layout.inspect.request", requestId: "old-retirement-reader" },
      select: () => null,
    }),
  ).rejects.toMatchObject({ code: "retirement_reader_required" });
  await expect(
    client.commitWorkspaceLayout({
      writerVersion: 2,
      requestId: "old-retirement-writer",
      expected: final.stamp,
      mutations: [
        {
          kind: "put",
          entry: final.entries.find(
            (entry) => entry.ref.workspaceId === replacement.workspace!.id,
          )!,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "retirement_writer_required" });

  const removed = await client.removeProject(replacement.workspace!.projectId);
  expect(removed.removedWorkspaceIds).toEqual([replacement.workspace!.id]);
  const newProjectWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: root },
  });
  const projectId = newProjectWorkspace.workspace!.projectId;
  const originalCommit = WorkspaceLayoutService.prototype.commit;
  const failingArchive = vi
    .spyOn(WorkspaceLayoutService.prototype, "commit")
    .mockImplementation(function (input) {
      if (input.mutations[0]?.kind === "archive-retirement")
        return Promise.reject(new Error("fixture archive receipt unavailable"));
      return originalCommit.call(this, input);
    });
  try {
    await expect(client.removeProject(projectId)).rejects.toThrow(
      "Project retirement remains fenced pending reconciliation",
    );
    const nativeFile = path.join(home, "projects", "workspaces.json");
    const nativeBeforeRetry = await readFile(nativeFile, "utf8");
    await expect(client.removeProject(projectId)).rejects.toThrow(
      "Project retirement remains fenced pending reconciliation",
    );
    expect(await readFile(nativeFile, "utf8")).toBe(nativeBeforeRetry);
    expect((await client.listProjects()).projects.some((row) => row.projectId === projectId)).toBe(
      true,
    );
    const pending = (await client.getWorkspaceLayout()).retirements!.find((operation) =>
      operation.targets.some(
        (target) => target.ref.workspaceId === newProjectWorkspace.workspace!.id,
      ),
    );
    expect(pending?.state).toBe("reserved");
    const native = JSON.parse(nativeBeforeRetry) as Array<{
      workspaceId: string;
      archivedAt: string | null;
    }>;
    expect(
      native.find((record) => record.workspaceId === newProjectWorkspace.workspace!.id)?.archivedAt,
    ).toEqual(expect.any(String));
  } finally {
    failingArchive.mockRestore();
  }
}, 30_000);

test("REV69 real teardown subprocess verifies its non-default owner home and completes canonical archive", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { acquirePidLock, releasePidLock } = await import("./pid-lock.js");
  const ownerRoot = path.join(root, "non-default-owner");
  const home = path.join(ownerRoot, ".paseo");
  await mkdir(home, { recursive: true });
  vi.stubEnv("PASEO_HOME", path.join(root, "different-inherited-home"));
  vi.stubEnv("PASEO_HOST", undefined);
  vi.stubEnv("PASEO_PASSWORD", undefined);
  const serverId = "srv_hook_owner_fixture";
  await writeFile(path.join(home, "server-id"), serverId);
  const logger = pino({ level: "silent" });
  const keys = await loadOrCreateDaemonKeyPair(home, logger);
  const mode = {
    role: "authority" as const,
    semanticsVersion: 2 as const,
    authorityServerId: serverId,
    authorityKeySha256: createHash("sha256").update(keys.publicKeyB64).digest("hex"),
    authorityId: randomUUID(),
    epoch: randomUUID(),
  };
  const fixturePassword = "fixture-positive-hook-only";
  const fixture = await createTestPaseoDaemon({
    auth: { password: hashSync(fixturePassword, 4) },
    paseoHomeRoot: ownerRoot,
    cleanup: false,
    workspaceLayout: mode,
    agentClients: {},
    pluginsEnabled: false,
    relayEnabled: false,
    logger,
  });
  cleanup.push(() => fixture.close());
  await acquirePidLock(home, `127.0.0.1:${fixture.port}`);
  cleanup.push(() => releasePidLock(home));
  const client = createHostClient(`tcp://127.0.0.1:${fixture.port}`, {
    clientId: randomUUID(),
    password: fixturePassword,
    reconnect: { enabled: false },
  });
  cleanup.push(() => client.close());
  await client.connect();
  const initial = (await client.initializeWorkspaceLayout(mode)).snapshot;
  await client.commitWorkspaceLayout({
    writerVersion: 2,
    requestId: "hook-import",
    expected: initial.stamp,
    mutations: [
      {
        kind: "import-host",
        previousSourceSha256: null,
        source: { serverId, sourceSha256: "a".repeat(64), resolutionSha256: "b".repeat(64) },
        entries: [],
      },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "c".repeat(64) },
      },
    ],
  });
  const imported = await client.getWorkspaceLayout();
  await client.commitWorkspaceLayout({
    writerVersion: 2,
    requestId: "hook-activate",
    expected: imported.stamp,
    mutations: [
      {
        kind: "activate",
        requiredImports: imported.imports,
        requiredOwnerDomains: imported.ownerDomains,
      },
    ],
  });
  const repo = path.join(root, "hook-repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
  const marker = path.join(root, "verified-hook.json");
  const cli = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  await writeFile(
    path.join(repo, "verify-hook.mjs"),
    `import {spawnSync} from "node:child_process";import {writeFileSync} from "node:fs";
const e=process.env;const result=spawnSync(process.execPath,["--conditions=source","--import",${JSON.stringify(tsx)},${JSON.stringify(cli)},"workspace","retirement-verify",e.PASEO_RETIREMENT_OPERATION_ID,"--workspace-id",e.PASEO_RETIREMENT_WORKSPACE_ID,"--backing-generation",e.PASEO_RETIREMENT_BACKING_GENERATION,"--worktree-path",e.PASEO_RETIREMENT_WORKTREE_PATH,"--teardown-cwd",e.PASEO_RETIREMENT_TEARDOWN_CWD,"--home",e.PASEO_HOME,"--json"],{env:e,encoding:"utf8",timeout:15000});
if(result.status!==0)throw new Error("fixture retirement-verify refused");const parsed=JSON.parse(result.stdout);const data=parsed.data??parsed;if(data.valid!==true)throw new Error("fixture verification not valid");writeFileSync(${JSON.stringify(marker)},JSON.stringify({valid:data.valid,operationId:e.PASEO_RETIREMENT_OPERATION_ID,workspaceId:e.PASEO_RETIREMENT_WORKSPACE_ID,ownerHome:e.PASEO_HOME}));`,
  );
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(
    path.join(repo, "paseo.json"),
    JSON.stringify({ worktree: { teardown: [quote(process.execPath) + " verify-hook.mjs"] } }),
  );
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "owned hook fixture"], {
    cwd: repo,
    stdio: "pipe",
  });
  const created = await client.createWorkspace({
    source: { kind: "worktree", cwd: repo, worktreeSlug: "positive-hook", baseBranch: "main" },
  });
  expect(created.error).toBeNull();
  const workspace = created.workspace!;
  const operationId = randomUUID();
  const result = await client.archiveWorkspace(workspace.id, { operationId });
  expect(result.error).toBeNull();
  expect(result.retirement).toMatchObject({ operationId, state: "complete" });
  expect(result.removedDirectory).toBe(true);
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
    valid: true,
    operationId,
    workspaceId: workspace.id,
    ownerHome: home,
  });
  expect(await client.getWorkspaceRetirementStatus(operationId)).toMatchObject({
    state: "complete",
    code: null,
  });
  await expect(
    readFile(path.join(workspace.workspaceDirectory!, "paseo.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 45000);
