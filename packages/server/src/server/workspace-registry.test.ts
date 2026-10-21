import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("createPersistedWorkspaceRecord defaults background to false and preserves explicit intent", () => {
    const base = {
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout" as const,
      displayName: "main",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    expect(createPersistedWorkspaceRecord(base).background).toBe(false);
    expect(createPersistedWorkspaceRecord({ ...base, background: false }).background).toBe(false);
    expect(createPersistedWorkspaceRecord({ ...base, background: true }).background).toBe(true);
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("preserves a concurrent project update when archiving", async () => {
    let pauseNextWrite = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const concurrentRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "concurrent-projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          if (pauseNextWrite) {
            pauseNextWrite = false;
            writeStarted();
            await release;
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-concurrent",
      rootPath: "/tmp/project-concurrent",
      kind: "git",
      displayName: "project-concurrent",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await concurrentRegistry.upsert(project);
    pauseNextWrite = true;

    const update = concurrentRegistry.update(project.projectId, (current) => ({
      ...current,
      customName: "Kept name",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));
    await started;
    const archive = concurrentRegistry.archive(project.projectId, "2026-03-03T00:00:00.000Z");
    releaseWrite();
    await Promise.all([update, archive]);

    expect(await concurrentRegistry.get(project.projectId)).toMatchObject({
      customName: "Kept name",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove("project-unknown");

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("refreshes workspace archive timestamps when an archive is repeated", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z");
    await workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z");

    expect(await workspaceRegistry.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("persists the consumed change request with the workspace archive", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-auto-archive",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-auto-archive", "2026-03-02T00:00:00.000Z", {
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("workspace-auto-archive")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});

describe("superpin persistence", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "superpin-registry-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const base = {
    workspaceId: "workspace",
    projectId: "project",
    cwd: "/tmp/repo",
    kind: "directory" as const,
    displayName: "Workspace",
    archivedAt: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };

  test("3fdb71dd-7bc7-8193-83f6-cc37ba6c9dd9@0a9e62e2a465#registry-reload old records default null and orphaned superpins regain a pin", async () => {
    const file = path.join(directory, "workspaces.json");
    await writeJsonFileAtomic(file, [
      base,
      { ...base, workspaceId: "orphan", pinnedAt: null, superpinnedAt: "2026-10-18T01:00:00.000Z" },
    ]);
    const registry = new FileBackedWorkspaceRegistry(file, createTestLogger());
    expect(await registry.get("workspace")).toMatchObject({ pinnedAt: null, superpinnedAt: null });
    expect(await registry.get("orphan")).toMatchObject({
      pinnedAt: "2026-10-18T01:00:00.000Z",
      superpinnedAt: "2026-10-18T01:00:00.000Z",
    });
    await registry.update("workspace", (record) => ({
      ...record,
      pinnedAt: "2026-10-18T02:00:00.000Z",
      superpinnedAt: "2026-10-18T03:00:00.000Z",
    }));
    const reloaded = new FileBackedWorkspaceRegistry(file, createTestLogger());
    expect(await reloaded.list()).toEqual(await registry.list());
  });

  test("3fdb71dd-7bc7-8193-83f6-cc37ba6c9dd9@0a9e62e2a465#registry-reload orphan upserts publish the same normalized state they persist", async () => {
    const file = path.join(directory, "workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(file, createTestLogger());
    const published: unknown[] = [];
    registry.subscribeToMutations((mutation) => {
      published.push(mutation.workspace);
    });
    const time = "2026-10-18T01:00:00.000Z";
    await registry.upsert({
      ...createPersistedWorkspaceRecord(base),
      pinnedAt: null,
      superpinnedAt: time,
    });
    const reloaded = await new FileBackedWorkspaceRegistry(file, createTestLogger()).get(
      "workspace",
    );
    expect(reloaded).toMatchObject({ pinnedAt: time, superpinnedAt: time });
    expect(published).toEqual([reloaded]);
  });

  test("3fdb71dd7bc781d5b43fd310bea8633b@34667a09e7f5#concurrent competing superpin, re-pin and unpin commit whole records in order", async () => {
    const writes: Array<{ pinnedAt: string | null; superpinnedAt: string | null }> = [];
    const registry = new FileBackedWorkspaceRegistry(
      path.join(directory, "workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async (file, records) => {
          await writeJsonFileAtomic(file, records);
          writes.push({ pinnedAt: records[0].pinnedAt, superpinnedAt: records[0].superpinnedAt });
        },
      },
    );
    await registry.upsert(createPersistedWorkspaceRecord(base));
    writes.length = 0;
    const priority = "2026-10-18T01:00:00.000Z";
    const repin = "2026-10-18T02:00:00.000Z";
    await Promise.all([
      registry.update("workspace", (record) => ({
        ...record,
        pinnedAt: record.pinnedAt ?? priority,
        superpinnedAt: priority,
      })),
      registry.update("workspace", (record) => ({ ...record, pinnedAt: repin })),
      registry.update("workspace", (record) => ({
        ...record,
        pinnedAt: null,
        superpinnedAt: null,
      })),
    ]);
    expect(writes).toEqual([
      { pinnedAt: priority, superpinnedAt: priority },
      { pinnedAt: repin, superpinnedAt: priority },
      { pinnedAt: null, superpinnedAt: null },
    ]);
    expect(
      await new FileBackedWorkspaceRegistry(
        path.join(directory, "workspaces.json"),
        createTestLogger(),
      ).get("workspace"),
    ).toMatchObject(writes[2]);
  });
});

describe("ordered workspace hierarchy", () => {
  let hierarchyDir: string;
  let registry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();
  function record(
    workspaceId: string,
    parentWorkspaceId: string | null = null,
    projectId = "project",
  ) {
    return createPersistedWorkspaceRecord({
      workspaceId,
      parentWorkspaceId,
      projectId,
      cwd: `/tmp/${workspaceId}`,
      kind: "directory",
      displayName: workspaceId,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    });
  }
  beforeEach(() => {
    hierarchyDir = mkdtempSync(path.join(os.tmpdir(), "workspace-hierarchy-"));
    registry = new FileBackedWorkspaceRegistry(path.join(hierarchyDir, "workspaces.json"), logger);
  });
  afterEach(() => rmSync(hierarchyDir, { recursive: true, force: true }));

  test("appends concurrent creations with unique durable ranks and preserves parentage on reload", async () => {
    await registry.upsert(record("parent"));
    await Promise.all(["a", "b", "c"].map((id) => registry.upsert(record(id, "parent"))));
    const children = (await registry.list()).filter(
      (entry) => entry.parentWorkspaceId === "parent",
    );
    expect(children.map((entry) => entry.siblingOrder)).toEqual([1024, 2048, 3072]);
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(hierarchyDir, "workspaces.json"),
      logger,
    );
    expect(await reloaded.get("b")).toMatchObject({
      parentWorkspaceId: "parent",
      siblingOrder: 2048,
    });
  });

  test("moves and orders a subtree without moving descendants or losing parentage to stale metadata", async () => {
    for (const id of ["a", "b", "c"]) await registry.upsert(record(id));
    await registry.upsert(record("grandchild", "c"));
    const stale = await registry.get("c");
    const [moved] = await registry.move({
      workspaceId: "c",
      parentWorkspaceId: null,
      beforeWorkspaceId: "b",
    });
    expect(moved?.siblingOrder).toBe(1536);
    await registry.move({ workspaceId: "c", parentWorkspaceId: "a" });
    expect(await registry.get("grandchild")).toMatchObject({ parentWorkspaceId: "c" });
    if (!stale) throw new Error("Expected workspace");
    await registry.upsert({ ...stale, title: "Refreshed" });
    expect(await registry.get("c")).toMatchObject({ parentWorkspaceId: "a", title: "Refreshed" });
    await registry.move({ workspaceId: "c", parentWorkspaceId: null, beforeWorkspaceId: "a" });
    expect((await registry.get("c"))?.siblingOrder).toBeLessThan(
      (await registry.get("a"))?.siblingOrder ?? 0,
    );
  });

  test("rejects invalid parents, cycles and sibling insertion targets without mutation", async () => {
    await registry.upsert(record("root"));
    await registry.upsert(record("child", "root"));
    await registry.upsert(record("other", null, "different-project"));
    await registry.upsert(record("archived"));
    await registry.archive("archived", "2026-10-21T01:00:00.000Z");
    const before = await registry.list();
    for (const input of [
      { workspaceId: "root", parentWorkspaceId: "root" },
      { workspaceId: "root", parentWorkspaceId: "child" },
      { workspaceId: "child", parentWorkspaceId: "missing" },
      { workspaceId: "child", parentWorkspaceId: "archived" },
      { workspaceId: "child", parentWorkspaceId: "other" },
      { workspaceId: "root", parentWorkspaceId: null, beforeWorkspaceId: "child" },
    ])
      await expect(registry.move(input)).rejects.toThrow();
    expect(await registry.list()).toEqual(before);
  });

  test("serializes competing moves so concurrent requests cannot create a cycle", async () => {
    await registry.upsert(record("a"));
    await registry.upsert(record("b"));
    const outcomes = await Promise.allSettled([
      registry.move({ workspaceId: "a", parentWorkspaceId: "b" }),
      registry.move({ workspaceId: "b", parentWorkspaceId: "a" }),
    ]);
    expect(outcomes.map((entry) => entry.status)).toEqual(["fulfilled", "rejected"]);
    expect(await registry.get("a")).toMatchObject({ parentWorkspaceId: "b" });
    expect(await registry.get("b")).toMatchObject({ parentWorkspaceId: null });
  });

  test.each(["precision", "duplicates"])(
    "rebalances %s exhausted ranks atomically before inserting",
    async (mode) => {
      for (const id of ["a", "b", "c"]) await registry.upsert(record(id));
      await registry.update("a", (entry) => ({ ...entry, siblingOrder: 1 }));
      await registry.update("b", (entry) => ({
        ...entry,
        siblingOrder: mode === "precision" ? 1 + Number.EPSILON : 1,
      }));
      const changed = await registry.move({
        workspaceId: "c",
        parentWorkspaceId: null,
        beforeWorkspaceId: "b",
      });
      expect(changed).toHaveLength(3);
      const ranks = new Map(
        (await registry.list()).map((entry) => [entry.workspaceId, entry.siblingOrder]),
      );
      expect(ranks.get("a")).toBe(1024);
      expect(ranks.get("c")).toBe(1536);
      expect(ranks.get("b")).toBe(2048);
    },
  );

  test("archive and removal promote direct children and publish every affected workspace", async () => {
    await registry.upsert(record("root"));
    await registry.upsert(record("parent", "root"));
    await registry.upsert(record("child", "parent"));
    await registry.upsert(record("grandchild", "child"));
    const publications: string[] = [];
    registry.subscribeToMutations((mutation) => {
      publications.push(`${mutation.kind}:${mutation.workspaceId}`);
    });
    await registry.archive("parent", "2026-10-21T01:00:00.000Z");
    expect(await registry.get("child")).toMatchObject({ parentWorkspaceId: "root" });
    expect(await registry.get("grandchild")).toMatchObject({ parentWorkspaceId: "child" });
    expect(publications).toEqual(["archive:parent", "upsert:child"]);
    await registry.remove("root");
    expect(await registry.get("child")).toMatchObject({ parentWorkspaceId: null });
  });

  test("loads missing hierarchy fields as deterministic roots and persists them on the next write", async () => {
    const file = path.join(hierarchyDir, "legacy.json");
    const legacy = [record("b"), record("a")].map((entry) => {
      const { parentWorkspaceId: _parent, siblingOrder: _order, ...rest } = entry;
      return rest;
    });
    await writeJsonFileAtomic(file, legacy);
    const legacyRegistry = new FileBackedWorkspaceRegistry(file, logger);
    expect(await legacyRegistry.get("a")).toMatchObject({
      parentWorkspaceId: null,
      siblingOrder: 1024,
    });
    expect(await legacyRegistry.get("b")).toMatchObject({
      parentWorkspaceId: null,
      siblingOrder: 2048,
    });
    await legacyRegistry.update("a", (entry) => ({ ...entry, title: "Renamed" }));
    const reloaded = new FileBackedWorkspaceRegistry(file, logger);
    expect(await reloaded.get("b")).toMatchObject({ parentWorkspaceId: null, siblingOrder: 2048 });
  });
  test.each(["archive", "remove"])(
    "restores archived children after parent %s under a surviving ancestor or root",
    async (operation) => {
      await registry.upsert(record("root"));
      await registry.upsert(record("parent", "root"));
      await registry.upsert(record("child", "parent"));
      await registry.archive("child", "2026-10-21T01:00:00.000Z");
      if (operation === "archive") await registry.archive("parent", "2026-10-21T02:00:00.000Z");
      else await registry.remove("parent");
      const child = await registry.get("child");
      if (!child) throw new Error("Expected child");
      await registry.upsert({ ...child, archivedAt: null });
      expect(await registry.get("child")).toMatchObject({
        archivedAt: null,
        parentWorkspaceId: operation === "archive" ? "root" : null,
      });
    },
  );
  test("a failed disk write leaves hierarchy and its publications unchanged", async () => {
    let failWrite = false;
    const failing = new FileBackedWorkspaceRegistry(
      path.join(hierarchyDir, "failure.json"),
      logger,
      {
        writeRecords: async (file, records) => {
          if (failWrite) throw new Error("Disk write failed");
          await writeJsonFileAtomic(file, records);
        },
      },
    );
    await failing.upsert(record("parent"));
    await failing.upsert(record("child"));
    const publications: string[] = [];
    failing.subscribeToMutations((mutation) => {
      publications.push(mutation.workspaceId);
    });
    failWrite = true;
    await expect(
      failing.move({ workspaceId: "child", parentWorkspaceId: "parent" }),
    ).rejects.toThrow("Disk write failed");
    expect(await failing.get("child")).toMatchObject({
      parentWorkspaceId: null,
      siblingOrder: 2048,
    });
    expect(publications).toEqual([]);
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(hierarchyDir, "failure.json"),
      logger,
    );
    expect(await reloaded.get("child")).toMatchObject({
      parentWorkspaceId: null,
      siblingOrder: 2048,
    });
  });
});
