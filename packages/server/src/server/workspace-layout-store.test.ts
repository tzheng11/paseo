import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkspaceLayoutCommit,
  WorkspaceLayoutEntry,
  WorkspaceLayoutIdentity,
  WorkspaceLayoutMutation,
  WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import {
  WorkspaceLayoutStore,
  writeLayoutFileDurably,
  validateLayoutGraph,
} from "./workspace-layout-store.js";

const identity: WorkspaceLayoutIdentity = {
  authorityServerId: "srv_hub",
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
const timestamp = "2026-11-04T10:00:00.000Z";
function entry(host = "srv_a", workspaceId = "wks_same"): WorkspaceLayoutEntry {
  return {
    ref: { serverId: host, workspaceId },
    projectId: "project",
    pinnedAt: timestamp,
    superpinnedAt: null,
    parent: null,
    siblingOrder: 0,
    pinPlacement: null,
    archivedAt: null,
    revision: 0,
  };
}
function imported(host: string, rows: WorkspaceLayoutEntry[], hash = "a"): WorkspaceLayoutMutation {
  return {
    kind: "import-host",
    source: {
      serverId: host,
      sourceSha256: hash.repeat(64),
      resolutionSha256: "b".repeat(64),
    },
    previousSourceSha256: null,
    entries: rows,
  };
}
function request(
  snapshot: WorkspaceLayoutSnapshot,
  mutations: WorkspaceLayoutMutation[],
): WorkspaceLayoutCommit {
  return { requestId: randomUUID(), expected: snapshot.stamp, mutations };
}

describe("canonical workspace layout authority", () => {
  let home: string;
  let store: WorkspaceLayoutStore;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paseo-layout-"));
    store = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seed(rows = [entry()]): Promise<WorkspaceLayoutSnapshot> {
    const initial = await store.initialize(identity);
    const groups = Map.groupBy(rows, (row) => row.ref.serverId);
    await store.commit(
      request(
        initial,
        [...groups].map(([host, records]) => imported(host, records)),
      ),
    );
    const importing = await store.inspect();
    await store.commit(
      request(importing, [{ kind: "activate", requiredImports: importing.imports }]),
    );
    return store.inspect();
  }

  it("never invents an empty layout on an ordinary read", async () => {
    await expect(store.inspect()).rejects.toMatchObject({ code: "not_initialized" });
    await expect(readFile(path.join(home, "workspace-layout.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const snapshot = await store.initialize(identity);
    expect(snapshot).toMatchObject({
      stamp: { ...identity, phase: "importing", revision: 0 },
      entries: [],
    });
    expect(await store.initialize(identity)).toEqual(snapshot);
  });

  it("binds the exact authority server, identity and epoch", async () => {
    expect(
      () => new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_other" }),
    ).toThrow("authority_server_mismatch");
    await expect(store.initialize({ ...identity, epoch: randomUUID() })).rejects.toThrow(
      "authority_identity_mismatch",
    );
  });

  it("preserves distinct host-qualified IDs, archived ordinary pins and superpins across restart", async () => {
    const archived = { ...entry("srv_a"), superpinnedAt: timestamp, archivedAt: timestamp };
    const state = await seed([archived, entry("srv_b")]);
    const fresh = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
    expect(await fresh.inspect()).toEqual(state);
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({
      pinnedAt: timestamp,
      superpinnedAt: timestamp,
      archivedAt: timestamp,
    });
  });

  it("does not normalize missing, undefined or invalid pin observations to unpinned", async () => {
    const state = await store.initialize(identity);
    for (const value of [undefined, "invalid", 0]) {
      const row = { ...entry(), pinnedAt: value };
      await expect(
        store.commit(request(state, [imported("srv_a", [row as WorkspaceLayoutEntry])])),
      ).rejects.toThrow();
    }
    const row = Object.fromEntries(Object.entries(entry()).filter(([key]) => key !== "pinnedAt"));
    await expect(
      store.commit(request(state, [imported("srv_a", [row as WorkspaceLayoutEntry])])),
    ).rejects.toThrow();
    expect(await store.inspect()).toEqual(state);
  });

  it("requires every resolved import hash before activation", async () => {
    const state = await store.initialize(identity);
    await store.commit(request(state, [imported("srv_a", [entry()])]));
    const next = await store.inspect();
    await expect(
      store.commit(
        request(next, [
          {
            kind: "activate",
            requiredImports: [{ ...next.imports[0], resolutionSha256: "f".repeat(64) }],
          },
        ]),
      ),
    ).rejects.toThrow("import_manifest_mismatch");
    expect((await store.inspect()).stamp.phase).toBe("importing");
  });

  it("allows unresolved cross-host parents during staged import but refuses activation until resolved", async () => {
    const child = {
      ...entry("srv_a", "child"),
      pinPlacement: {
        parentWorkspaceKey: "srv_b:parent",
        siblingOrder: 1,
        revision: 0,
      },
    };
    await store.commit(request(await store.initialize(identity), [imported("srv_a", [child])]));
    const partial = await store.inspect();
    await expect(
      store.commit(request(partial, [{ kind: "activate", requiredImports: partial.imports }])),
    ).rejects.toThrow("unresolved_parent");
    await store.commit(request(partial, [imported("srv_b", [entry("srv_b", "parent")])]));
    const complete = await store.inspect();
    await store.commit(
      request(complete, [{ kind: "activate", requiredImports: complete.imports }]),
    );
    expect((await store.inspect()).stamp.phase).toBe("active");
  });

  it("refuses cross-host cycles, mismatched sections and structural cross-project links atomically", async () => {
    const current = await seed([entry("srv_a", "a"), entry("srv_b", "b")]);
    const [a, b] = current.entries;
    const child = {
      ...a,
      pinPlacement: { parentWorkspaceKey: "srv_b:b", siblingOrder: 0, revision: 1 },
    };
    const cycle = {
      ...b,
      pinPlacement: { parentWorkspaceKey: "srv_a:a", siblingOrder: 0, revision: 1 },
    };
    await expect(
      store.commit(
        request(current, [
          { kind: "put", entry: child },
          { kind: "put", entry: cycle },
        ]),
      ),
    ).rejects.toThrow("workspace_cycle");
    await expect(
      store.commit(
        request(current, [
          { kind: "put", entry: child },
          { kind: "put", entry: { ...b, pinnedAt: null } },
        ]),
      ),
    ).rejects.toThrow("parent_section_mismatch");
    await expect(
      store.commit(request(current, [{ kind: "put", entry: { ...a, parent: b.ref } }])),
    ).rejects.toThrow("structural_parent_host_mismatch");
    expect(await store.inspect()).toEqual(current);
  });

  it("refuses orphan superpins and duplicate identities without losing the prior file", async () => {
    const state = await store.initialize(identity);
    await expect(
      store.commit(
        request(state, [
          imported("srv_a", [{ ...entry(), pinnedAt: null, superpinnedAt: timestamp }]),
        ]),
      ),
    ).rejects.toThrow("orphan_superpin");
    await expect(
      store.commit(request(state, [imported("srv_a", [entry(), entry()])])),
    ).rejects.toThrow("duplicate_workspace_identity");
    expect(await store.inspect()).toEqual(state);
  });

  it("preserves a structural child pinned in a different sidebar section from its parent", async () => {
    const parent = { ...entry("srv_a", "parent"), pinnedAt: null };
    const child = { ...entry("srv_a", "child"), parent: parent.ref };
    const state = await seed([parent, child]);
    expect(state.entries.find((record) => record.ref.workspaceId === "child")).toMatchObject({
      parent: parent.ref,
      pinnedAt: timestamp,
      pinPlacement: null,
    });
  });

  it("validates deep metadata without recursive stack growth or repeated ancestor scans", () => {
    const rows = Array.from({ length: 12000 }, (_, index) => ({
      ...entry("srv_a", String(index)),
      pinnedAt: null,
      parent: index === 0 ? null : { serverId: "srv_a", workspaceId: String(index - 1) },
    }));
    const state: WorkspaceLayoutSnapshot = {
      stamp: { ...identity, phase: "active", revision: 0 },
      entries: rows,
      imports: [],
    };
    expect(() => validateLayoutGraph(state)).not.toThrow();
    rows[0].parent = { serverId: "srv_a", workspaceId: "11999" };
    expect(() => validateLayoutGraph(state)).toThrow("workspace_cycle");
  });

  it("uses global and entry CAS and deduplicates an identical unknown-outcome retry before CAS", async () => {
    const state = await seed();
    const input = request(state, [
      { kind: "put", entry: { ...state.entries[0], superpinnedAt: timestamp } },
    ]);
    const receipt = await store.commit(input);
    expect(await store.commit(input)).toEqual(receipt);
    expect((await store.inspect()).stamp.revision).toBe(state.stamp.revision + 1);
    await expect(
      store.commit({ ...input, mutations: [{ kind: "put", entry: state.entries[0] }] }),
    ).rejects.toThrow("request_id_conflict");
    await expect(store.commit({ ...input, requestId: randomUUID() })).rejects.toThrow(
      "stale_revision",
    );
    const now = await store.inspect();
    await expect(
      store.commit(request(now, [{ kind: "put", entry: state.entries[0] }])),
    ).rejects.toThrow("stale_entry_revision");
  });

  it("refuses import replacement without its previous source and never drops an archived row", async () => {
    await store.commit(request(await store.initialize(identity), [imported("srv_a", [entry()])]));
    const current = await store.inspect();
    await expect(
      store.commit(request(current, [imported("srv_a", [entry()], "c")])),
    ).rejects.toThrow("stale_import_source");
    const update = { ...imported("srv_a", [], "c"), previousSourceSha256: "a".repeat(64) };
    await expect(store.commit(request(current, [update]))).rejects.toThrow(
      "import_drops_existing_workspace",
    );
  });

  it("refuses imports and anonymous normal writes at the wrong bootstrap phase", async () => {
    const initial = await store.initialize(identity);
    await expect(store.commit(request(initial, [{ kind: "put", entry: entry() }]))).rejects.toThrow(
      "layout_importing",
    );
    const active = await seed();
    await expect(
      store.commit(request(active, [imported("srv_new", [entry("srv_new")])])),
    ).rejects.toThrow("import_closed");
  });

  it("never recreates a missing or corrupt initialized authority", async () => {
    await seed();
    const file = path.join(home, "workspace-layout.json");
    await rm(file);
    await expect(store.inspect()).rejects.toThrow("restore_authority_store");
    await expect(store.initialize(identity)).rejects.toThrow("restore_authority_store");
    await writeFile(file, '{"partial":');
    await expect(store.inspect()).rejects.toThrow();
    await expect(store.initialize(identity)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe('{"partial":');
  });

  it("preserves a durable receipt when publication fails and recovers it without another mutation", async () => {
    const state = await seed();
    const stop = store.subscribe(() => {
      throw new Error("subscriber failed");
    });
    const input = request(state, [{ kind: "put", entry: { ...state.entries[0], pinnedAt: null } }]);
    await expect(store.commit(input)).rejects.toThrow("subscriber failed");
    stop();
    const receipt = await store.commit(input);
    expect(receipt.stamp.revision).toBe(state.stamp.revision + 1);
    expect((await store.inspect()).entries[0].pinnedAt).toBeNull();
  });

  it("fails closed on a held/abandoned writer lock instead of deleting it", async () => {
    await mkdir(path.join(home, "workspace-layout.json.lock"));
    await expect(store.initialize(identity)).rejects.toThrow("authority_busy");
    expect(await readFile(path.join(home, "workspace-layout.json")).catch(() => null)).toBeNull();
  });

  it("keeps the prior revision if durable persistence fails, and releases its own lock", async () => {
    const state = await seed();
    let failing = true;
    const failureStore = new WorkspaceLayoutStore({
      paseoHome: home,
      identity,
      serverId: "srv_hub",
      write: async (file, data) => {
        if (failing) throw new Error("disk full");
        await writeLayoutFileDurably(file, data);
      },
    });
    const input = request(state, [{ kind: "put", entry: { ...state.entries[0], pinnedAt: null } }]);
    await expect(failureStore.commit(input)).rejects.toThrow("disk full");
    expect(await store.inspect()).toEqual(state);
    failing = false;
    await failureStore.commit(input);
    expect((await store.inspect()).entries[0].pinnedAt).toBeNull();
  });
});
