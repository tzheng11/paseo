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
