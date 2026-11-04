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
import {
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { CanonicalWorkspaceRegistry } from "./workspace-layout-registry.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { setWorkspacePinPlacement } from "./workspace-pin-placement.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import { createTestRegistries } from "./test-fixtures/reconciliation-registries.js";

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
    siblingOrder: record.siblingOrder ?? 0,
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
async function registry(records: PersistedWorkspaceRecord[], name = "a") {
  const file = path.join(home, name, "workspaces.json");
  const old = new FileBackedWorkspaceRegistry(file, createTestLogger());
  for (const record of records) await old.upsert(record);
  const value = new CanonicalWorkspaceRegistry(file, createTestLogger(), service, "srv_a");
  registries.push(value);
  await value.initialize();
  return { value, file };
}

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
  const cached = vi.spyOn(service, "cached").mockReturnValue({ snapshot: stale, fresh: true });
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
  const cached = vi.spyOn(service, "cached").mockReturnValue({ snapshot: stale, fresh: true });
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
