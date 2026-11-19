import { createLargeLayoutFixture } from "./test-fixtures/canonical-layout-scale.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import type {
  WorkspaceLayoutEntry,
  WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import { emptyWorkspaceNavigationPreferences } from "@getpaseo/protocol/workspace-layout";
import * as layoutProtocol from "@getpaseo/protocol/workspace-layout";
import {
  FileBackedWorkspaceRegistry,
  FileBackedProjectRegistry,
  createPersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { CanonicalWorkspaceRegistry } from "./workspace-layout-registry.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { setWorkspacePinPlacement } from "./workspace-pin-placement.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import { createTestRegistries } from "./test-fixtures/reconciliation-registries.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";

const at = "2026-11-04T10:00:00.000Z";
const config = {
  role: "authority" as const,
  authorityServerId: "srv_hub",
  authorityKeySha256: "a".repeat(64),
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
function row(id: string): PersistedWorkspaceRecord {
  return {
    workspaceId: id,
    projectId: "project",
    cwd: `/fixture/${id}`,
    kind: "directory",
    displayName: id,
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    superpinnedAt: null,
    parentWorkspaceId: null,
    siblingOrder: 0,
    background: false,
  };
}
function canonical(record: PersistedWorkspaceRecord, serverId = "srv_a"): WorkspaceLayoutEntry {
  return {
    ref: { serverId, workspaceId: record.workspaceId },
    projectId: record.projectId,
    pinnedAt: record.pinnedAt,
    superpinnedAt: record.superpinnedAt,
    parent: record.parentWorkspaceId ? { serverId, workspaceId: record.parentWorkspaceId } : null,
    siblingOrder: record.siblingOrder ?? null,
    pinPlacement: record.pinPlacement ?? null,
    archivedAt: record.archivedAt,
    revision: 0,
  };
}
let home: string;
let service: WorkspaceLayoutService;
const registries: CanonicalWorkspaceRegistry[] = [];
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paseo-canonical-registry-"));
  service = new WorkspaceLayoutService({ home, serverId: "srv_hub", config, failed: () => {} });
});
afterEach(async () => {
  await Promise.all(registries.splice(0).map((current) => current.close()));
  await service.close();
  await rm(home, { recursive: true, force: true });
});
async function seed(records: PersistedWorkspaceRecord[], activate = true) {
  const initial = await service.initialize(config);
  await service.commit({
    requestId: randomUUID(),
    expected: initial.stamp,
    mutations: [
      {
        kind: "import-host",
        source: {
          serverId: "srv_a",
          sourceSha256: "a".repeat(64),
          resolutionSha256: "b".repeat(64),
        },
        previousSourceSha256: null,
        entries: records.map((record) => canonical(record)),
      },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "0".repeat(64) },
      },
    ],
  });
  const imported = await service.inspect();
  if (activate)
    await service.commit({
      requestId: randomUUID(),
      expected: imported.stamp,
      mutations: [{ kind: "activate", requiredImports: imported.imports }],
    });
}
async function registry(records: PersistedWorkspaceRecord[], name = "a", serverId = "srv_a") {
  const file = path.join(home, name, "workspaces.json");
  const old = new FileBackedWorkspaceRegistry(file, createTestLogger());
  for (const record of records) await old.upsert(record);
  const value = new CanonicalWorkspaceRegistry(file, createTestLogger(), service, serverId);
  registries.push(value);
  await value.initialize();
  return { value, file };
}

async function largeReadFixture(
  phase: "importing" | "active",
  options: { directories?: boolean } = {},
) {
  await service.close();
  const fixture = await createLargeLayoutFixture({ home, phase, ...options });
  service = fixture.service;
  registries.push(fixture.value);
  return fixture;
}

it.each([
  { phase: "importing" as const, count: 440, derives: 0, pin: "2026-11-04T09:00:00.000Z" },
  { phase: "active" as const, count: 439, derives: 1, pin: at },
])(
  "bounds 3308-entry $phase reads with 440 local rows while preserving publication",
  async ({ phase, count, derives, pin }) => {
    const { value, file, records, childPin } = await largeReadFixture(phase);
    const before = await readFile(file, "utf8");
    const cached = vi.spyOn(service, "cachedReadView");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
    try {
      const listed = await value.list();
      expect(cached).toHaveBeenCalledTimes(1);
      expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(1);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(derives);
      expect(listed.map((record) => record.workspaceId)).toEqual(
        records.slice(0, count).map((record) => record.workspaceId),
      );
      expect(listed[0].pinnedAt).toBe(pin);
      expect(listed[1].pinnedAt).toBe(childPin);
      expect(listed[2]).toMatchObject({ archivedAt: at, pinnedAt: childPin });
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      derive.mockRestore();
      clone.mockRestore();
      cached.mockRestore();
    }
  },
);

function isGraphClone(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("entries" in value && Array.isArray(value.entries)) return true;
  return "snapshot" in value && isGraphClone(value.snapshot);
}

it.each(["importing", "active"] as const)(
  "bounds entry reads over 3308 entries and 440 local rows in %s",
  async (phase) => {
    const { value, records, childPin } = await largeReadFixture(phase);
    const cached = vi.spyOn(service, "cached");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
    try {
      const results = await Promise.all(
        records.slice(0, 439).map((record) => value.get(record.workspaceId)),
      );
      expect(results[0]).toMatchObject({
        workspaceId: "large-0",
        pinnedAt: phase === "active" ? at : childPin,
      });
      expect(results[1]).toMatchObject({ pinnedAt: childPin });
      expect(results[2]).toMatchObject({ archivedAt: at });
      expect(cached).toHaveBeenCalledTimes(0);
      expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(0);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(phase === "active" ? 1 : 0);
    } finally {
      derive.mockRestore();
      clone.mockRestore();
      cached.mockRestore();
    }
  },
);

it.each(["importing", "active"] as const)(
  "updates local metadata without copying the 3308-entry graph in %s",
  async (phase) => {
    const { value, childPin } = await largeReadFixture(phase);
    const cached = vi.spyOn(service, "cached");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
    try {
      const result = await value.update("large-0", (record) => ({
        ...record,
        title: "updated metadata",
      }));
      expect(result).toMatchObject({
        title: "updated metadata",
        pinnedAt: phase === "active" ? at : childPin,
      });
      expect(cached).toHaveBeenCalledTimes(0);
      expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(0);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(phase === "active" ? 1 : 0);
    } finally {
      derive.mockRestore();
      clone.mockRestore();
      cached.mockRestore();
    }
  },
);

it.each(["importing", "active"] as const)(
  "upserts existing metadata without graph copies in %s",
  async (phase) => {
    const { value, records, file, childPin } = await largeReadFixture(phase);
    const cached = vi.spyOn(service, "cached");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
    try {
      await value.upsert({ ...records[0], title: "upserted metadata", pinnedAt: null });
      expect(cached).not.toHaveBeenCalled();
      expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(0);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(phase === "active" ? 1 : 0);
    } finally {
      derive.mockRestore();
      clone.mockRestore();
      cached.mockRestore();
    }
    expect(await value.get("large-0")).toMatchObject({
      title: "upserted metadata",
      pinnedAt: phase === "active" ? at : childPin,
    });
    expect(JSON.parse(await readFile(file, "utf8"))[0].pinnedAt).toBe(childPin);
  },
);

it.each([
  { phase: "importing" as const, method: "runOnce" as const },
  { phase: "active" as const, method: "runOnce" as const },
  { phase: "importing" as const, method: "reconcileGitMetadata" as const },
  { phase: "active" as const, method: "reconcileGitMetadata" as const },
  { phase: "importing" as const, method: "reconcileNow" as const },
  { phase: "active" as const, method: "reconcileNow" as const },
])("bounds the entire $method pass at 3308/440 scale in $phase", async ({ phase, method }) => {
  const { value, file, records, childPin } = await largeReadFixture(phase, { directories: true });
  const projects = new FileBackedProjectRegistry(
    path.join(home, "projects.json"),
    createTestLogger(),
  );
  await projects.initialize();
  await projects.upsert(
    createPersistedProjectRecord({
      projectId: "project",
      rootPath: home,
      kind: "non_git",
      displayName: "scale",
      createdAt: at,
      updatedAt: at,
    }),
  );
  const changes = vi.fn();
  const workspacesChanged = vi.fn(async () => {});
  const git = createNoopWorkspaceGitService();
  const reconciliation = new WorkspaceReconciliationService({
    projectRegistry: projects,
    workspaceRegistry: value,
    logger: createTestLogger(),
    serverId: "srv_a",
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd) => ({
        ...(await git.getCheckout(cwd)),
        ...(cwd === records[0].cwd || cwd === records[1].cwd
          ? { isGit: true, currentBranch: "observed-branch", worktreeRoot: cwd }
          : {}),
      }),
    }),
    onChanges: changes,
    onWorkspacesChanged: workspacesChanged,
  });
  const cached = vi.spyOn(service, "cached");
  const clone = vi.spyOn(globalThis, "structuredClone");
  const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
  try {
    await reconciliation[method]();
    expect(cached.mock.calls.length).toBeLessThanOrEqual(1);
    expect(clone.mock.calls.filter(([input]) => isGraphClone(input)).length).toBeLessThanOrEqual(1);
    expect(derive.mock.calls.length).toBeLessThanOrEqual(phase === "active" ? 1 : 0);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace_updated", workspaceId: "large-0" }),
        expect.objectContaining({ kind: "workspace_updated", workspaceId: "large-1" }),
      ]),
    );
    if (method === "reconcileNow")
      expect(workspacesChanged).toHaveBeenCalledWith(
        expect.arrayContaining(["large-0", "large-1"]),
      );
    const retained: PersistedWorkspaceRecord[] = JSON.parse(await readFile(file, "utf8"));
    expect(retained).toHaveLength(440);
    expect(retained.filter((record) => record.archivedAt)).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      branch: "observed-branch",
      kind: "local_checkout",
      pinnedAt: childPin,
      pinPlacement: { parentWorkspaceKey: "srv_b:large-440", siblingOrder: 0 },
    });
    expect(retained[1]).toMatchObject({
      branch: "observed-branch",
      pinnedAt: childPin,
      pinPlacement: { parentWorkspaceKey: "srv_unknown:missing" },
    });
    expect(retained[439]).toMatchObject({ branch: null, archivedAt: null });
  } finally {
    derive.mockRestore();
    clone.mockRestore();
    cached.mockRestore();
    reconciliation.dispose();
  }
});

it.each(["importing", "active"] as const)(
  "bounds protection initialization at 3308/440 scale in %s",
  async (phase) => {
    const { value, file } = await largeReadFixture(phase);
    const before = await readFile(file, "utf8");
    const cached = vi.spyOn(service, "cached");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
    try {
      await value.initialize();
      expect(cached.mock.calls.length).toBeLessThanOrEqual(1);
      expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(1);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(phase === "active" ? 1 : 0);
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      derive.mockRestore();
      clone.mockRestore();
      cached.mockRestore();
    }
  },
);

it("isolates indexed entry reads and sees new revisions without rebuilding on every get", async () => {
  const { value, records, childPin } = await largeReadFixture("active");
  const copiedView = service.cachedReadView();
  copiedView.entries.clear();
  if (!copiedView.snapshot?.entries[0].pinPlacement)
    throw new Error("fixture copied placement missing");
  copiedView.snapshot.entries[0].pinPlacement.siblingOrder = 8888;
  const first = await value.get("large-0");
  if (!first?.pinPlacement) throw new Error("fixture placement missing");
  first.pinPlacement.siblingOrder = 9999;
  expect(await value.get("large-0")).toMatchObject({
    pinPlacement: { siblingOrder: 0 },
    pinnedAt: at,
  });
  expect(await value.get("large-1")).toMatchObject({ pinnedAt: childPin, effectiveSection: null });
  await expect(value.get("large-439")).rejects.toThrow("workspace_not_imported");
  const before = await service.inspect();
  const parent = before.entries.find(
    (entry) => entry.ref.serverId === "srv_b" && entry.ref.workspaceId === "large-440",
  );
  if (!parent?.sectionIntent) throw new Error("fixture parent missing");
  const changedPin = "2026-11-04T13:00:00.000Z";
  await service.commit({
    writerVersion: 2,
    requestId: "entry-index-new-revision",
    expected: before.stamp,
    mutations: [
      {
        kind: "put",
        entry: {
          ...parent,
          pinnedAt: changedPin,
          sectionIntent: { ...parent.sectionIntent, mode: "explicit" },
        },
      },
    ],
  });
  expect(await value.get("large-0")).toMatchObject({
    pinnedAt: changedPin,
    pinPlacement: { siblingOrder: 0 },
  });
  const derive = vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout");
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    await Promise.all(records.slice(0, 439).map((record) => value.get(record.workspaceId)));
    expect(derive).not.toHaveBeenCalled();
    expect(clone.mock.calls.filter(([input]) => isGraphClone(input))).toHaveLength(0);
  } finally {
    derive.mockRestore();
    clone.mockRestore();
  }
});

it.each(["importing", "active"] as const)(
  "retains fresh local metadata within a shared %s canonical read batch",
  async (phase) => {
    const { value } = await largeReadFixture(phase);
    await value.withReadBatch(async (reader) => {
      const first = await reader.get("large-0");
      if (!first?.pinPlacement) throw new Error("fixture placement missing");
      first.pinPlacement.siblingOrder = 1234;
      await value.update("large-0", (record) => ({ ...record, cwd: home, title: "new metadata" }));
      expect(await reader.get("large-0")).toMatchObject({
        cwd: home,
        title: "new metadata",
        pinPlacement: { siblingOrder: 0 },
      });
    });
  },
);

it("isolates large active read snapshots and sees a new authority revision on the next list", async () => {
  const { value, file, childPin } = await largeReadFixture("active");
  const first = await value.list();
  expect(first[1]).toMatchObject({ pinnedAt: childPin, effectiveSection: null });
  expect(first[0].pinPlacement).toEqual({
    parentWorkspaceKey: "srv_b:large-440",
    siblingOrder: 0,
    revision: 1,
  });
  const placement = first[0].pinPlacement;
  if (!placement) throw new Error("large fixture placement missing");
  placement.siblingOrder = 9000;
  const before = await service.inspect();
  expect(
    before.entries.find((entry) => entry.ref.workspaceId === "large-0")?.pinPlacement?.siblingOrder,
  ).toBe(0);
  const parent = before.entries.find((entry) => entry.ref.workspaceId === "large-440");
  if (!parent?.sectionIntent) throw new Error("large fixture parent missing");
  const nextPin = "2026-11-04T11:00:00.000Z";
  await service.commit({
    writerVersion: 2,
    requestId: "large-new-revision",
    expected: before.stamp,
    mutations: [
      {
        kind: "put",
        entry: {
          ...parent,
          pinnedAt: nextPin,
          sectionIntent: { ...parent.sectionIntent, mode: "explicit" },
        },
      },
    ],
  });
  const next = await value.list();
  expect(next[0]).toMatchObject({ pinnedAt: nextPin, pinPlacement: { siblingOrder: 0 } });
  expect(next[1]).toMatchObject({ pinnedAt: childPin, effectiveSection: null });
  expect(next[2]).toMatchObject({ archivedAt: at, pinnedAt: childPin });
  expect(JSON.parse(await readFile(file, "utf8"))[0].pinnedAt).toBe(childPin);
});

it("routes ordinary pin and superpin writes through one durable authority across independent clients", async () => {
  const original = row("one");
  await seed([original]);
  const a = await registry([original], "client-a");
  const b = await registry([original], "client-b");
  const before = await service.inspect();
  await a.value.update("one", (record) => ({ ...record, pinnedAt: at, superpinnedAt: at }), {
    requestId: "pin",
  });
  expect(await b.value.get("one")).toMatchObject({ pinnedAt: at, superpinnedAt: at });
  const after = await service.inspect();
  expect(after.stamp.revision).toBe(before.stamp.revision + 1);
  expect(after.entries[0]).toMatchObject({ pinnedAt: at, superpinnedAt: at });
  expect((await b.value.get("one"))?.cwd).toBe(original.cwd);
});

it.each(["pin", "creation"])(
  "re-inspects a definite global CAS refusal caused by another host's concurrent %s write",
  async (kind) => {
    const original = row("one");
    await seed([original], false);
    const importing = await service.inspect();
    await service.commit({
      requestId: "import-b",
      expected: importing.stamp,
      mutations: [
        {
          kind: "import-host",
          previousSourceSha256: null,
          source: {
            serverId: "srv_b",
            sourceSha256: "c".repeat(64),
            resolutionSha256: "d".repeat(64),
          },
          entries: [canonical(row("two"), "srv_b")],
        },
      ],
    });
    const imported = await service.inspect();
    await service.commit({
      requestId: "activate-both",
      expected: imported.stamp,
      mutations: [{ kind: "activate", requiredImports: imported.imports }],
    });
    const a = await registry([original], "host-a");
    const b = await registry([row("two")], "host-b", "srv_b");
    const commit = service.commit.bind(service);
    let interleaved = false;
    const attempts: string[] = [];
    const spy = vi.spyOn(service, "commit").mockImplementation(async (input) => {
      if (
        input.mutations.some(
          (mutation) => mutation.kind === "put" && mutation.entry.ref.serverId === "srv_a",
        )
      ) {
        attempts.push(input.requestId);
        if (!interleaved) {
          interleaved = true;
          await b.value.update("two", (record) => ({ ...record, pinnedAt: at }), {
            requestId: "other-host",
            layoutWrite: true,
          });
        }
      }
      return commit(input);
    });
    try {
      if (kind === "pin")
        await a.value.update("one", (record) => ({ ...record, pinnedAt: at }), {
          requestId: "my-intent",
          layoutWrite: true,
        });
      else await a.value.upsert(row("created"), { requestId: "my-intent" });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe("my-intent");
      expect(attempts[1]).not.toBe(attempts[0]);
      expect((await b.value.get("two"))?.pinnedAt).toBe(at);
      expect(await a.value.get(kind === "pin" ? "one" : "created")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  },
);

it("never retries a mutation with an unknown transport outcome", async () => {
  const original = row("one");
  await seed([original]);
  const { value } = await registry([original]);
  const before = await service.inspect();
  const spy = vi
    .spyOn(service, "commit")
    .mockRejectedValue(
      Object.assign(new Error("lost acknowledgement"), { code: "DAEMON_CONNECTION_LOST" }),
    );
  try {
    await expect(
      value.update("one", (record) => ({ ...record, pinnedAt: at }), {
        requestId: "once",
        layoutWrite: true,
      }),
    ).rejects.toThrow("lost acknowledgement");
    expect(spy).toHaveBeenCalledOnce();
    expect(await service.inspect()).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});

it("bounds definite CAS retries and never writes a local record when contention does not settle", async () => {
  await seed([row("one")]);
  const { value } = await registry([row("one")]);
  const spy = vi
    .spyOn(service, "commit")
    .mockRejectedValue(Object.assign(new Error("contention"), { code: "stale_revision" }));
  try {
    await expect(value.upsert(row("not-created"))).rejects.toThrow("contention");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(new Set(spy.mock.calls.map(([input]) => input.requestId)).size).toBe(3);
    expect(await value.get("not-created")).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

it("quarantines an unimported record without losing its local holds or breaking reads of imported workspaces", async () => {
  const known = row("known");
  const unknown = { ...row("unimported"), pinnedAt: at, superpinnedAt: at };
  await seed([known]);
  const { value, file } = await registry([known, unknown]);
  expect((await value.list()).map((record) => record.workspaceId)).toEqual(["known"]);
  expect(await value.get("known")).not.toBeNull();
  await expect(value.get("unimported")).rejects.toThrow("workspace_not_imported");
  const retained = JSON.parse(await readFile(file, "utf8")).find(
    (record: PersistedWorkspaceRecord) => record.workspaceId === "unimported",
  );
  expect(retained).toMatchObject({ pinnedAt: at, superpinnedAt: at });
});

it("keeps the local creation protection copy equal to the committed canonical order", async () => {
  await seed([row("one")]);
  const { value, file } = await registry([row("one")]);
  await value.upsert(row("new"));
  const canonicalRow = (await service.inspect()).entries.find(
    (entry) => entry.ref.workspaceId === "new",
  );
  const local = JSON.parse(await readFile(file, "utf8")).find(
    (record: PersistedWorkspaceRecord) => record.workspaceId === "new",
  );
  expect(local.siblingOrder).toBe(canonicalRow?.siblingOrder);
});

it("preserves an imported unranked root in legacy responses and its local protection copy", async () => {
  const unranked = { ...row("z-id"), displayName: "Alpha", siblingOrder: undefined };
  await seed([unranked]);
  const { value, file } = await registry([unranked]);
  expect((await value.get("z-id"))?.siblingOrder).toBeUndefined();
  expect(JSON.parse(await readFile(file, "utf8"))[0]).not.toHaveProperty("siblingOrder");
  await value.update("z-id", (record) => ({ ...record, pinnedAt: at }));
  expect((await service.inspect()).entries[0].siblingOrder).toBeNull();
});

it("only ranks an unranked group on an explicit move, retaining its numeric-then-name order", async () => {
  const records = [
    { ...row("ranked"), siblingOrder: 7, title: "ZZZ" },
    { ...row("z-id"), siblingOrder: undefined, title: "Alpha" },
    { ...row("a-id"), siblingOrder: undefined, title: "Zulu" },
    { ...row("moving"), siblingOrder: undefined, title: "Omega" },
  ];
  await seed(records);
  const { value } = await registry(records);
  await value.upsert({ ...row("new"), siblingOrder: undefined });
  expect(
    (await service.inspect()).entries.find((entry) => entry.ref.workspaceId === "new")
      ?.siblingOrder,
  ).toBeNull();
  await value.move("moving", { parentWorkspaceId: null, beforeWorkspaceId: "a-id" });
  const ordered = (await value.list())
    .sort((a, b) => a.siblingOrder! - b.siblingOrder!)
    .map((record) => record.workspaceId);
  expect(ordered).toEqual(["ranked", "z-id", "new", "moving", "a-id"]);
});

it("never lets a stale whole-record reconciliation overwrite layout or host-local identity", async () => {
  const parent = row("parent");
  const child = { ...row("child"), pinnedAt: at };
  await seed([parent, child]);
  const { value } = await registry([parent, child]);
  await value.update("child", (record) => ({ ...record, superpinnedAt: at }));
  await value.upsert({ ...child, title: "Current title", projectId: "stale-project" });
  expect(await value.get("child")).toMatchObject({
    pinnedAt: at,
    superpinnedAt: at,
    title: "Current title",
    projectId: "project",
  });
  expect(
    (await service.inspect()).entries.find((entry) => entry.ref.workspaceId === "child")?.projectId,
  ).toBe("project");
});

it("retains archived ordinary/superpin holds in the on-disk protection replica", async () => {
  const archived = { ...row("archived"), archivedAt: at, pinnedAt: at, superpinnedAt: at };
  await seed([archived]);
  const { value, file } = await registry([{ ...archived, pinnedAt: null, superpinnedAt: null }]);
  expect(await value.get("archived")).toMatchObject({
    archivedAt: at,
    pinnedAt: at,
    superpinnedAt: at,
  });
  expect(JSON.parse(await readFile(file, "utf8"))[0]).toMatchObject({
    archivedAt: at,
    pinnedAt: at,
    superpinnedAt: at,
  });
  await expect(value.archive()).rejects.toThrow("canonical_retirement_reservation_required");
  await expect(value.remove()).rejects.toThrow("canonical_retirement_reservation_required");
});

it("persists host-owned unarchive and project observations while preserving canonical pin holds", async () => {
  const archived = { ...row("returning"), archivedAt: at, pinnedAt: at, superpinnedAt: at };
  await seed([archived]);
  const { value, file } = await registry([archived]);
  await value.update("returning", (record) => ({
    ...record,
    archivedAt: null,
    projectId: "new-project",
  }));
  expect(await value.get("returning")).toMatchObject({
    archivedAt: null,
    projectId: "new-project",
    pinnedAt: at,
    superpinnedAt: at,
  });
  expect(JSON.parse(await readFile(file, "utf8"))[0]).toMatchObject({
    archivedAt: null,
    projectId: "new-project",
    pinnedAt: at,
    superpinnedAt: at,
  });
  expect((await service.inspect()).entries[0]).toMatchObject({
    archivedAt: null,
    projectId: "new-project",
    pinnedAt: at,
    superpinnedAt: at,
  });
});

it("restores an imported archived workspace through the actual provisioning path without overwriting a newer layout", async () => {
  const archived = { ...row("restored"), cwd: home, archivedAt: at, pinnedAt: at };
  await seed([archived]);
  const { value, file } = await registry([archived]);
  const { projectRegistry, projects } = createTestRegistries();
  projects.set("project", {
    projectId: "project",
    rootPath: home,
    kind: "non_git",
    displayName: "fixture",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    customName: null,
    projectKey: null,
  });
  const stale = await value.get("restored");
  await value.update("restored", (current) => ({ ...current, superpinnedAt: at }));
  const provisioning = createWorkspaceProvisioningService({
    serverId: "srv_a",
    workspaceRegistry: value,
    projectRegistry,
    workspaceGitService: createNoopWorkspaceGitService(),
    isDirectory: async () => true,
    logger: createTestLogger(),
  });
  const restored = await provisioning.ensureWorkspaceRecordUnarchived(stale!);
  expect(restored).toMatchObject({
    workspaceId: "restored",
    archivedAt: null,
    pinnedAt: at,
    superpinnedAt: at,
  });
  expect(await value.get("restored")).toMatchObject({ archivedAt: null, superpinnedAt: at });
  expect(JSON.parse(await readFile(file, "utf8"))[0]).toMatchObject({
    archivedAt: null,
    superpinnedAt: at,
  });
  expect((await service.inspect()).entries[0]).toMatchObject({
    archivedAt: null,
    superpinnedAt: at,
  });
});

it("keeps missing canonical workspaces during reconciliation without preventing daemon bootstrap", async () => {
  const original = row("missing");
  await seed([original]);
  const { value } = await registry([original]);
  const { projectRegistry, projects } = createTestRegistries();
  projects.set("project", {
    projectId: "project",
    rootPath: home,
    kind: "non_git",
    displayName: "fixture",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    customName: null,
    projectKey: null,
  });
  const reconciliation = new WorkspaceReconciliationService({
    projectRegistry,
    workspaceRegistry: value,
    logger: createTestLogger(),
    inspectDirectory: async (target) => (target === home ? "directory" : "missing"),
  });
  const result = await reconciliation.runOnce();
  expect(result.changesApplied.filter((change) => change.kind === "workspace_archived")).toEqual(
    [],
  );
  expect((await value.get("missing"))?.archivedAt).toBeNull();
  expect((await service.inspect()).entries[0].archivedAt).toBeNull();
});

it("fences legacy layout writes during import without blocking unrelated local workspace metadata", async () => {
  const original = row("one");
  await seed([original], false);
  const { value } = await registry([original]);
  await value.update("one", (record) => ({ ...record, title: "Local execution remains local" }));
  await expect(value.update("one", (record) => ({ ...record, pinnedAt: at }))).rejects.toThrow(
    "layout_importing",
  );
  expect(await value.get("one")).toMatchObject({
    pinnedAt: null,
    title: "Local execution remains local",
  });
});

it("checks explicit pin intent against fresh authority state even when the stale replica appears unchanged", async () => {
  const original = { ...row("one"), pinnedAt: at };
  await seed([original]);
  const { value } = await registry([original]);
  const stale = await service.inspect();
  await service.commit({
    requestId: "newer-unpin",
    expected: stale.stamp,
    mutations: [{ kind: "put", entry: { ...stale.entries[0], pinnedAt: null } }],
  });
  const cached = vi.spyOn(service, "cachedWorkspace").mockImplementation(() =>
    structuredClone({
      stamp: stale.stamp,
      semanticsVersion: stale.semanticsVersion,
      entry: stale.entries[0],
      effective: null,
      derived: false,
      fresh: true,
    }),
  );
  try {
    await value.update("one", (record) => ({ ...record, pinnedAt: at }), {
      requestId: "repin",
      layoutWrite: true,
    });
    expect((await service.inspect()).entries[0].pinnedAt).toBe(at);
  } finally {
    cached.mockRestore();
  }
});

it("refuses stale placement revision before it can overwrite a newer authority move", async () => {
  const original = { ...row("one"), pinnedAt: at };
  await seed([original]);
  const { value } = await registry([original]);
  const stale = await service.inspect();
  await setWorkspacePinPlacement(
    value,
    {
      workspaceId: "one",
      expectedRevision: 0,
      placement: { parentWorkspaceKey: null, siblingOrder: 50 },
    },
    "srv_a",
  );
  const before = await service.inspect();
  const cached = vi.spyOn(service, "cachedWorkspace").mockImplementation(() =>
    structuredClone({
      stamp: stale.stamp,
      semanticsVersion: stale.semanticsVersion,
      entry: stale.entries[0],
      effective: null,
      derived: false,
      fresh: true,
    }),
  );
  try {
    await expect(
      setWorkspacePinPlacement(
        value,
        {
          workspaceId: "one",
          expectedRevision: 0,
          placement: { parentWorkspaceKey: null, siblingOrder: 99 },
        },
        "srv_a",
      ),
    ).rejects.toThrow("moved in another client");
    expect(await service.inspect()).toEqual(before);
  } finally {
    cached.mockRestore();
  }
});

it("commits structural sibling moves atomically and refuses cycles", async () => {
  const records = [row("parent"), row("a"), { ...row("b"), siblingOrder: 1 }];
  await seed(records);
  const { value } = await registry(records);
  const moved = await value.move(
    "b",
    { parentWorkspaceId: "parent", beforeWorkspaceId: null },
    { requestId: "move-b" },
  );
  expect(moved).toMatchObject({ parentWorkspaceId: "parent", siblingOrder: 0 });
  const before = await service.inspect();
  await expect(value.move("parent", { parentWorkspaceId: "b" })).rejects.toThrow("workspace_cycle");
  expect(await service.inspect()).toEqual(before);
});

it("routes placement CAS through the same authority and keeps the backing workspace in place", async () => {
  const original = { ...row("one"), pinnedAt: at };
  await seed([original]);
  const { value } = await registry([original]);
  const placement = await setWorkspacePinPlacement(
    value,
    {
      workspaceId: "one",
      placement: { parentWorkspaceKey: null, siblingOrder: 500 },
      expectedRevision: 0,
      requestId: "placement",
      section: "superpinned",
    },
    "srv_a",
  );
  expect(placement).toMatchObject({ siblingOrder: 500, revision: 1 });
  expect((await service.inspect()).entries[0]).toMatchObject({
    superpinnedAt: expect.any(String),
    pinPlacement: placement,
  });
  expect(await value.get("one")).toMatchObject({
    cwd: original.cwd,
    projectId: original.projectId,
  });
});

it("registers new workspaces once while preserving older imported pin state", async () => {
  const first = { ...row("one"), pinnedAt: at };
  await seed([first]);
  const { value } = await registry([first]);
  await value.upsert(row("two"), { requestId: "new-two" });
  expect((await service.inspect()).entries).toHaveLength(2);
  expect(await value.get("one")).toMatchObject({ pinnedAt: at });
  expect(await value.get("two")).toMatchObject({ cwd: "/fixture/two" });
});

it("does not fall back to a local writer when the configured authority is unreachable", async () => {
  const original = { ...row("one"), pinnedAt: at };
  const replicaHome = path.join(home, "offline");
  await mkdir(replicaHome);
  const replica = new WorkspaceLayoutService({
    home: replicaHome,
    serverId: "srv_a",
    config: { ...config, role: "replica" },
    failed: () => {},
  });
  const snapshot: WorkspaceLayoutSnapshot = {
    stamp: {
      authorityServerId: config.authorityServerId,
      authorityId: config.authorityId,
      epoch: config.epoch,
      revision: 8,
      phase: "active",
    },
    entries: [canonical(original)],
    imports: [],
  };
  await writeFile(
    path.join(replicaHome, "workspace-layout-replica.json"),
    JSON.stringify(snapshot),
  );
  const file = path.join(replicaHome, "workspaces.json");
  await new FileBackedWorkspaceRegistry(file, createTestLogger()).upsert(original);
  await replica.load();
  const value = new CanonicalWorkspaceRegistry(file, createTestLogger(), replica, "srv_a");
  try {
    const before = await readFile(file, "utf8");
    await expect(value.update("one", (record) => ({ ...record, pinnedAt: null }))).rejects.toThrow(
      "authority_unreachable",
    );
    expect(await readFile(file, "utf8")).toBe(before);
    expect(replica.cached().fresh).toBe(false);
    expect(await value.get("one")).toMatchObject({ pinnedAt: at });
  } finally {
    await value.close();
    await replica.close();
  }
});
