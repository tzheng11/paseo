import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceLayoutSnapshot,
  WorkspaceLayoutReceipt,
} from "@getpaseo/protocol/workspace-layout";
import { emptyWorkspaceNavigationPreferences } from "@getpaseo/protocol/workspace-layout";
import { createTestLogger } from "../test-utils/test-logger.js";
import { parseCapturedConfig } from "./persisted-config.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  parseCapturedProjectRegistry,
  parseCapturedWorkspaceRegistry,
} from "./workspace-registry.js";
import { WorkspaceLayoutStore, parseCapturedWorkspaceLayout } from "./workspace-layout-store.js";

const identity = {
  authorityServerId: "srv_hub",
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
const mode = { ...identity, role: "authority" as const, authorityKeySha256: "a".repeat(64) };
const absent = { state: "absent" as const };
const present = (value: unknown) => ({ state: "present" as const, bytes: JSON.stringify(value) });
function initial(): {
  schemaVersion: number;
  snapshot: WorkspaceLayoutSnapshot;
  receipts: Record<string, WorkspaceLayoutReceipt>;
} {
  return {
    schemaVersion: 3,
    snapshot: {
      stamp: { ...identity, revision: 0, phase: "importing" as "importing" | "active" },
      entries: [
        {
          ref: { serverId: "srv_a", workspaceId: "wks_a" },
          projectId: "project",
          pinnedAt: "2026-11-04T00:00:00.000Z",
          superpinnedAt: null,
          parent: null,
          siblingOrder: null,
          pinPlacement: null,
          archivedAt: null,
          revision: 1,
        },
      ],
      imports: [
        { serverId: "srv_a", sourceSha256: "b".repeat(64), resolutionSha256: "c".repeat(64) },
      ],
      clientImports: [
        {
          source: {
            sourceId: "client",
            sourceSha256: "d".repeat(64),
            resolutionSha256: "e".repeat(64),
          },
          preferences: { workspaceSort: "manual" as const },
          pinnedWorkspaceTree: { "srv_a:wks_a": { parentWorkspaceKey: null, siblingOrder: 5 } },
        },
      ],
      navigation: null,
    },
    receipts: {},
  };
}
function committed(active = false) {
  const file = initial();
  file.snapshot.stamp.revision = 1;
  if (active) {
    file.snapshot.stamp.phase = "active";
    file.snapshot.navigation = {
      revision: 1,
      preferences: emptyWorkspaceNavigationPreferences(),
      clientSources: file.snapshot.clientImports.map((entry) => entry.source),
      resolutionSha256: "f".repeat(64),
    };
  }
  const id = "__proto__";
  file.receipts[createHash("sha256").update(id).digest("hex")] = {
    requestId: id,
    requestSha256: "1".repeat(64),
    stamp: { ...file.snapshot.stamp },
  };
  return file;
}
function input(file = committed()) {
  return {
    serverId: "srv_hub",
    configured: mode,
    marker: present({ ...mode, schemaVersion: 1, destructiveRetirement: "refuse" }),
    store: present(file),
    guard: present({ ...identity, schemaVersion: 1, initialized: true }),
    replica: absent,
  };
}
const workspace = {
  workspaceId: "wks_a",
  projectId: "project",
  cwd: "/private/fixture",
  kind: "directory",
  displayName: "Fixture",
  createdAt: "2026-11-04",
  updatedAt: "2026-11-04",
  archivedAt: null,
};
afterEach(() => vi.restoreAllMocks());

describe("pure current-home byte inspection", () => {
  it("returns complete IMPORTING/nav-null bytes without filesystem calls, defaults or rank loss", () => {
    const file = committed();
    const read = vi.spyOn(fs, "readFile").mockImplementation(() => {
      throw new Error("unexpected IO");
    });
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(() => {
      throw new Error("unexpected IO");
    });
    const write = vi.spyOn(fs, "writeFile").mockImplementation(() => {
      throw new Error("unexpected IO");
    });
    expect(parseCapturedWorkspaceLayout(input(file))).toMatchObject({
      role: "authority",
      state: "initialized",
      store: file,
    });
    expect(parseCapturedWorkspaceRegistry(present([workspace]))).toEqual({
      state: "present",
      value: [workspace],
    });
    expect(parseCapturedConfig(present({ version: 1, workspaceLayout: mode }))).toEqual({
      state: "present",
      value: { version: 1, workspaceLayout: mode },
    });
    expect(read).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("parses exact real-writer initialization, importing and active files without repairs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-captured-layout-"));
    try {
      const writer = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
      let snapshot = await writer.initialize(identity);
      const capture = async () => ({
        ...input(),
        store: {
          state: "present" as const,
          bytes: await fs.readFile(path.join(home, "workspace-layout.json")),
        },
        guard: {
          state: "present" as const,
          bytes: await fs.readFile(path.join(home, "workspace-layout-initialized.json")),
        },
      });
      expect(parseCapturedWorkspaceLayout(await capture())).toMatchObject({
        state: "initialized",
        store: { snapshot },
      });
      await writer.commit({
        requestId: "import",
        expected: snapshot.stamp,
        mutations: [
          {
            kind: "import-host",
            source: committed().snapshot.imports[0],
            previousSourceSha256: null,
            entries: committed().snapshot.entries,
          },
          {
            kind: "import-client",
            input: committed().snapshot.clientImports![0],
            previousSourceSha256: null,
          },
        ],
      });
      snapshot = await writer.inspect();
      expect(parseCapturedWorkspaceLayout(await capture())).toMatchObject({ store: { snapshot } });
      await writer.commit({
        requestId: "navigation",
        expected: snapshot.stamp,
        mutations: [
          {
            kind: "put-navigation",
            expectedRevision: 0,
            preferences: emptyWorkspaceNavigationPreferences(),
            importResolution: {
              clientSources: snapshot.clientImports!.map((item) => item.source),
              resolutionSha256: "f".repeat(64),
            },
          },
        ],
      });
      snapshot = await writer.inspect();
      await writer.commit({
        requestId: "activate",
        expected: snapshot.stamp,
        mutations: [
          {
            kind: "activate",
            requiredImports: snapshot.imports,
            requiredClientImports: snapshot.clientImports!.map((item) => item.source),
          },
        ],
      });
      snapshot = await writer.inspect();
      expect(parseCapturedWorkspaceLayout(await capture())).toMatchObject({ store: { snapshot } });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it("accepts independent navigation revisions from multiple real mutations in one commit", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-captured-navigation-"));
    try {
      const writer = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
      const initialized = await writer.initialize(identity);
      await writer.commit({
        requestId: "two-navigation-mutations",
        expected: initialized.stamp,
        mutations: [0, 1].map((expectedRevision) => ({
          kind: "put-navigation" as const,
          expectedRevision,
          preferences: emptyWorkspaceNavigationPreferences(),
          importResolution: { clientSources: [], resolutionSha256: "f".repeat(64) },
        })),
      });
      const captured = {
        ...input(),
        store: {
          state: "present" as const,
          bytes: await fs.readFile(path.join(home, "workspace-layout.json")),
        },
        guard: {
          state: "present" as const,
          bytes: await fs.readFile(path.join(home, "workspace-layout-initialized.json")),
        },
      };
      expect(parseCapturedWorkspaceLayout(captured)).toMatchObject({
        store: { snapshot: { stamp: { revision: 1 }, navigation: { revision: 2 } } },
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it("retains exact bytes produced by the real project and workspace registry writers", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-captured-registries-"));
    try {
      const projectFile = path.join(home, "projects/projects.json");
      const workspaceFile = path.join(home, "projects/workspaces.json");
      const projects = new FileBackedProjectRegistry(projectFile, createTestLogger());
      const workspaces = new FileBackedWorkspaceRegistry(workspaceFile, createTestLogger());
      const project = createPersistedProjectRecord({
        projectId: "project",
        rootPath: home,
        kind: "non_git",
        displayName: "Fixture",
        createdAt: "2026-11-04",
        updatedAt: "2026-11-04",
      });
      const row = createPersistedWorkspaceRecord({
        ...workspace,
        kind: "directory",
        cwd: home,
        pinnedAt: "2026-11-04",
        archivedAt: "2026-11-04",
      });
      await projects.upsert(project);
      await workspaces.upsert(row);
      const projectBytes = await fs.readFile(projectFile);
      const workspaceBytes = await fs.readFile(workspaceFile);
      expect(parseCapturedProjectRegistry({ state: "present", bytes: projectBytes })).toEqual({
        state: "present",
        value: JSON.parse(projectBytes.toString()),
      });
      expect(parseCapturedWorkspaceRegistry({ state: "present", bytes: workspaceBytes })).toEqual({
        state: "present",
        value: JSON.parse(workspaceBytes.toString()),
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it("preserves ACTIVE shared navigation, client provenance and all receipts", () => {
    const file = committed(true);
    const parsed = parseCapturedWorkspaceLayout(input(file));
    expect(parsed).toMatchObject({ role: "authority", state: "initialized", store: file });
    expect("store" in parsed && parsed.store).toEqual(file);
  });
  it("distinguishes known absent, unreadable, uninitialized, legacy and replica cache states", () => {
    expect(parseCapturedWorkspaceRegistry(absent)).toEqual(absent);
    expect(parseCapturedConfig(absent)).toEqual(absent);
    expect(
      parseCapturedWorkspaceLayout({ ...input(), store: absent, guard: absent }),
    ).toMatchObject({ role: "authority", state: "uninitialized", guard: null });
    expect(
      parseCapturedWorkspaceLayout({
        ...input(),
        store: absent,
        guard: present({ ...identity, schemaVersion: 1, initialized: false }),
      }),
    ).toMatchObject({ role: "authority", state: "uninitialized", guard: { initialized: false } });
    expect(
      parseCapturedWorkspaceLayout({
        serverId: "srv_a",
        configured: undefined,
        marker: absent,
        store: absent,
        guard: absent,
        replica: absent,
      }),
    ).toEqual({ role: "legacy" });
    const replica = {
      ...input(),
      serverId: "srv_a",
      configured: { ...mode, role: "replica" as const },
      marker: absent,
      store: absent,
      guard: absent,
    };
    expect(parseCapturedWorkspaceLayout(replica)).toMatchObject({ role: "replica", cache: absent });
    expect(
      parseCapturedWorkspaceLayout({ ...replica, replica: present(committed(true).snapshot) }),
    ).toMatchObject({
      role: "replica",
      cache: { state: "present", value: committed(true).snapshot },
    });
    expect(() =>
      parseCapturedWorkspaceLayout({ ...replica, replica: { state: "unreadable" } }),
    ).toThrow("json_unreadable");
  });
  it.each(["missing", "uninitialized", "epoch", "extra"])(
    "refuses a %s authority guard without repairing it",
    (change) => {
      const data = input();
      const guard: Record<string, unknown> = { ...identity, schemaVersion: 1, initialized: true };
      if (change === "missing")
        return expect(() => parseCapturedWorkspaceLayout({ ...data, guard: absent })).toThrow(
          "initialized_guard_required",
        );
      if (change === "uninitialized") guard.initialized = false;
      if (change === "epoch") guard.epoch = "00000000-0000-4000-8000-000000000003";
      if (change === "extra") guard.unrecognized = "retained?";
      expect(() => parseCapturedWorkspaceLayout({ ...data, guard: present(guard) })).toThrow();
    },
  );
  it.each(["missing", "wrong-key", "future", "epoch", "phase", "duplicate-revision"])(
    "refuses %s commit receipts",
    (change) => {
      const file = committed();
      const [key, receipt] = Object.entries(file.receipts)[0];
      if (change === "missing") file.receipts = {};
      if (change === "wrong-key") {
        delete file.receipts[key];
        file.receipts["9".repeat(64)] = receipt;
      }
      if (change === "future") receipt.stamp.revision = 2;
      if (change === "epoch") receipt.stamp.epoch = "00000000-0000-4000-8000-000000000003";
      if (change === "phase") receipt.stamp.phase = "active";
      if (change === "duplicate-revision") {
        const requestId = "other";
        file.receipts[createHash("sha256").update(requestId).digest("hex")] = {
          ...receipt,
          requestId,
        };
      }
      expect(() => parseCapturedWorkspaceLayout(input(file))).toThrow();
    },
  );
  it.each([
    "cycle",
    "missing-active-parent",
    "missing-navigation",
    "missing-client-provenance",
    "omitted-navigation",
    "unknown-client-field",
    "future-entry",
    "duplicate-import",
  ])("refuses %s without normalizing layout data", (change) => {
    const file = committed(true);
    if (change === "cycle") file.snapshot.entries[0].parent = file.snapshot.entries[0].ref;
    if (change === "missing-active-parent")
      file.snapshot.entries[0].parent = { serverId: "srv_a", workspaceId: "missing" };
    if (change === "missing-navigation") file.snapshot.navigation = null;
    if (change === "missing-client-provenance")
      delete (file.snapshot as Partial<typeof file.snapshot>).clientImports;
    if (change === "omitted-navigation")
      delete (file.snapshot as Partial<typeof file.snapshot>).navigation;
    if (change === "unknown-client-field")
      Object.assign(file.snapshot.clientImports![0], { privateExtra: "must not disappear" });
    if (change === "future-entry") file.snapshot.entries[0].revision = 2;
    if (change === "duplicate-import") file.snapshot.imports.push(file.snapshot.imports[0]);
    expect(() => parseCapturedWorkspaceLayout(input(file))).toThrow();
  });
  it("retains pending IMPORTING references and dormant archived pin edges", () => {
    const file = committed();
    file.snapshot.entries[0].pinPlacement = {
      parentWorkspaceKey: "srv_b:pending",
      siblingOrder: 2,
      revision: 5,
    };
    file.snapshot.entries[0].archivedAt = "2026-11-04T00:00:00.000Z";
    expect(parseCapturedWorkspaceLayout(input(file))).toMatchObject({ store: file });
  });
  it("preserves legacy registry omissions, archived pin holds and extra supported values", () => {
    const row = {
      ...workspace,
      archivedAt: "2026-11-04",
      pinnedAt: "2026-10-01",
      labels: ["keep"],
      fieldValues: { note: "kept" },
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 1,
        headRepository: "fixture",
      },
    };
    expect(parseCapturedWorkspaceRegistry(present([row]))).toEqual({
      state: "present",
      value: [row],
    });
    const project = {
      projectId: "project",
      rootPath: "/private/fixture",
      kind: "non_git",
      displayName: "Fixture",
      createdAt: "2026-11-04",
      updatedAt: "2026-11-04",
      archivedAt: null,
    };
    expect(parseCapturedProjectRegistry(present([project]))).toEqual({
      state: "present",
      value: [project],
    });
  });
  it.each([
    ["unknown field", [{ ...workspace, unknown: "private" }]],
    [
      "unknown nested field",
      [
        {
          ...workspace,
          pinPlacement: { parentWorkspaceKey: null, siblingOrder: 0, revision: 0, unknown: true },
        },
      ],
    ],
    ["duplicate ID", [workspace, workspace]],
    ["orphan superpin repair", [{ ...workspace, pinnedAt: null, superpinnedAt: "2026-11-04" }]],
  ])("refuses registry %s rather than silently dropping or repairing data", (_name, rows) => {
    expect(() => parseCapturedWorkspaceRegistry(present(rows))).toThrow();
  });
  it("refuses nested unknown fields, duplicate JSON keys, invalid UTF8 and config normalization", () => {
    expect(() =>
      parseCapturedConfig(present({ daemon: { cors: { allowedOrigins: [], unknown: "secret" } } })),
    ).toThrow();
    expect(() => parseCapturedConfig(present({ daemon: { allowedHosts: ["localhost"] } }))).toThrow(
      "json_field_changed",
    );
    expect(() =>
      parseCapturedConfig({ state: "present", bytes: '{"version":1,"\u0076ersion":1}' }),
    ).toThrow("json_duplicate_key");
    expect(() => parseCapturedConfig({ state: "present", bytes: new Uint8Array([255]) })).toThrow(
      "json_invalid",
    );
    expect(() => parseCapturedWorkspaceRegistry({ state: "present", bytes: "[" })).toThrow(
      "json_invalid",
    );
    expect(() => parseCapturedWorkspaceRegistry({ state: "present", bytes: "{}" })).toThrow(
      "json_schema_invalid",
    );
  });
  it("honors a sticky mode but refuses mixed role files, identity and key changes", () => {
    expect(parseCapturedWorkspaceLayout({ ...input(), configured: undefined })).toMatchObject({
      role: "authority",
      state: "initialized",
    });
    expect(() =>
      parseCapturedWorkspaceLayout({
        ...input(),
        configured: { ...mode, authorityKeySha256: "b".repeat(64) },
      }),
    ).toThrow("home_authority_binding_changed");
    expect(() => parseCapturedWorkspaceLayout({ ...input(), serverId: "srv_other" })).toThrow(
      "authority_server_mismatch",
    );
    expect(() =>
      parseCapturedWorkspaceLayout({ ...input(), replica: present(committed().snapshot) }),
    ).toThrow("layout_role_data_mismatch");
    expect(() =>
      parseCapturedWorkspaceLayout({ ...input(), configured: undefined, marker: absent }),
    ).toThrow("unconfigured_layout_data");
  });
});
