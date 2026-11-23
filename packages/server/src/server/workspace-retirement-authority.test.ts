import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  WorkspaceLayoutCommitSchema,
  qualifyLegacyWorkspaceLayoutEntries,
  emptyWorkspaceNavigationPreferences,
} from "@getpaseo/protocol/workspace-layout";
import { WorkspaceLayoutStore, validateLayoutGraph } from "./workspace-layout-store.js";

const identity = {
  authorityServerId: "authority",
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
const homes: string[] = [];
async function fixture(unknownAncestor = false, activate = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), "retirement-authority-"));
  homes.push(home);
  const store = new WorkspaceLayoutStore({
    paseoHome: home,
    serverId: "authority",
    identity,
    semanticsVersion: 2,
  });
  let snapshot = await store.initialize(identity);
  async function commit(mutations: unknown[], writerVersion = 3, requestId = randomUUID()) {
    const input = WorkspaceLayoutCommitSchema.parse({
      writerVersion,
      expected: snapshot.stamp,
      requestId,
      mutations,
    });
    const receipt = await store.commit(input);
    snapshot = await store.inspect();
    return receipt;
  }
  const entries = qualifyLegacyWorkspaceLayoutEntries(
    ["a", "b", "c"].map((workspaceId) => ({
      ref: { serverId: "owner", workspaceId },
      projectId: "project",
      pinnedAt: null,
      superpinnedAt: null,
      parent: null,
      siblingOrder: null,
      pinPlacement: null,
      archivedAt: null,
      revision: 0,
    })),
  );
  if (unknownAncestor) {
    entries[0].pinPlacement = {
      parentWorkspaceKey: "studio:unknown-parent",
      siblingOrder: 0,
      revision: 1,
    };
    entries[0].sectionIntent = {
      mode: "inherit",
      baselineSection: "unpinned",
      baselineParentWorkspaceKey: "studio:unknown-parent",
    };
  }
  await commit(
    [
      { kind: "declare-unknown-owner", serverId: "studio" },
      {
        kind: "import-host",
        source: {
          serverId: "owner",
          sourceSha256: "a".repeat(64),
          resolutionSha256: "b".repeat(64),
        },
        previousSourceSha256: null,
        entries,
      },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "0".repeat(64) },
      },
    ],
    2,
  );
  if (activate)
    await commit(
      [
        {
          kind: "activate",
          requiredImports: snapshot.imports,
          requiredOwnerDomains: snapshot.ownerDomains,
        },
      ],
      2,
    );
  const operationId = randomUUID();
  const reserve = () => ({
    kind: "reserve-retirement",
    operationId,
    ownerServerId: "owner",
    backingGeneration: "c".repeat(64),
    targets: [{ ref: snapshot.entries[0].ref, revision: snapshot.entries[0].revision }],
  });
  return { store, home, commit, reserve, operationId, snapshot: () => snapshot };
}
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
it("reserves and durably retires an eligible exact leaf without veto by unrelated unknown Studio", async () => {
  const f = await fixture();
  const before = f.snapshot();
  await f.commit([f.reserve()]);
  expect(f.snapshot().retirements?.[0].state).toBe("reserved");
  expect(f.snapshot().entries).toEqual(before.entries);
  await f.commit([
    {
      kind: "archive-retirement",
      operationId: f.operationId,
      archivedAt: "2026-11-19T18:00:00.000Z",
    },
  ]);
  expect(f.snapshot().entries[0].archivedAt).toBe("2026-11-19T18:00:00.000Z");
  expect(f.snapshot().entries.slice(1)).toEqual(before.entries.slice(1));
  await f.commit([{ kind: "complete-retirement", operationId: f.operationId }]);
  const reopened = new WorkspaceLayoutStore({
    paseoHome: f.home,
    serverId: "authority",
    identity,
    semanticsVersion: 2,
  });
  expect(await reopened.inspect()).toEqual(f.snapshot());
});
it("fences pin, ancestor, child, competing retirement and old writers while unrelated writes continue", async () => {
  const f = await fixture();
  await f.commit([f.reserve()]);
  await expect(
    f.commit([
      { kind: "put", entry: { ...f.snapshot().entries[0], pinnedAt: "2026-11-19T18:00:00.000Z" } },
    ]),
  ).rejects.toThrow("retirement_conflict");
  await expect(
    f.commit([
      {
        kind: "put",
        entry: {
          ...f.snapshot().entries[1],
          parent: f.snapshot().entries[0].ref,
          sectionIntent: { ...f.snapshot().entries[1].sectionIntent!, mode: "explicit" },
        },
      },
    ]),
  ).rejects.toThrow("retirement_conflict");
  await expect(f.commit([{ ...f.reserve(), operationId: randomUUID() }])).rejects.toThrow(
    "retirement_conflict",
  );
  await expect(f.commit([{ kind: "put", entry: f.snapshot().entries[1] }], 2)).rejects.toThrow(
    "retirement_writer_required",
  );
  await f.commit([{ kind: "put", entry: f.snapshot().entries[1] }]);
});
it("refuses known live descendants, pins and stale footprint revisions before reservation", async () => {
  const f = await fixture();
  await f.commit([
    {
      kind: "put",
      entry: {
        ...f.snapshot().entries[1],
        parent: f.snapshot().entries[0].ref,
        sectionIntent: { ...f.snapshot().entries[1].sectionIntent!, mode: "explicit" },
      },
    },
  ]);
  await expect(f.commit([f.reserve()])).rejects.toThrow("retirement_live_descendant");
  await f.commit([{ kind: "put", entry: { ...f.snapshot().entries[1], parent: null } }]);
  await expect(
    f.commit([{ ...f.reserve(), targets: [{ ref: f.snapshot().entries[0].ref, revision: 999 }] }]),
  ).rejects.toThrow("entry_revision_conflict");
  await f.commit([
    { kind: "put", entry: { ...f.snapshot().entries[0], pinnedAt: "2026-11-19T18:00:00.000Z" } },
  ]);
  await expect(f.commit([f.reserve()])).rejects.toThrow("retirement_protected");
});
it("keeps the original receipt idempotent and rejects changed request contents, stale revision and epoch", async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const input = WorkspaceLayoutCommitSchema.parse({
    writerVersion: 3,
    requestId,
    expected: f.snapshot().stamp,
    mutations: [f.reserve()],
  });
  const receipt = await f.store.commit(input);
  expect(await f.store.commit(input)).toEqual(receipt);
  await expect(
    f.store.commit({
      ...input,
      mutations: [{ ...f.reserve(), backingGeneration: "d".repeat(64) }],
    }),
  ).rejects.toThrow("request_id_conflict");
  await expect(f.store.commit({ ...input, requestId: randomUUID() })).rejects.toThrow(
    "stale_revision",
  );
  await expect(
    f.store.commit({
      ...input,
      requestId: randomUUID(),
      expected: { ...input.expected, epoch: randomUUID() },
    }),
  ).rejects.toThrow("authority_identity_mismatch");
});
it("fences the complete ancestry read set while allowing an unrelated branch", async () => {
  const f = await fixture();
  await f.commit([
    {
      kind: "put",
      entry: {
        ...f.snapshot().entries[0],
        parent: f.snapshot().entries[1].ref,
        sectionIntent: { ...f.snapshot().entries[0].sectionIntent!, mode: "explicit" },
      },
    },
  ]);
  await f.commit([f.reserve()]);
  await expect(
    f.commit([
      { kind: "put", entry: { ...f.snapshot().entries[1], pinnedAt: "2026-11-19T18:00:00.000Z" } },
    ]),
  ).rejects.toThrow("retirement_conflict");
  await f.commit([{ kind: "put", entry: f.snapshot().entries[2] }]);
});
it("refuses an affected missing unknown-owner ancestor without treating unrelated unknown domains as empty", async () => {
  const f = await fixture(true);
  const before = f.snapshot();
  await expect(f.commit([f.reserve()])).rejects.toThrow("retirement_ancestry_unresolved");
  expect(await f.store.inspect()).toEqual(before);
});

it("refuses a late unknown-owner import that would orphan a live child of a retired tombstone", async () => {
  const f = await fixture();
  await f.commit([f.reserve()]);
  await f.commit([
    {
      kind: "archive-retirement",
      operationId: f.operationId,
      archivedAt: "2026-11-19T18:00:00.000Z",
    },
  ]);
  await f.commit([{ kind: "complete-retirement", operationId: f.operationId }]);
  const domain = f.snapshot().ownerDomains!.find((row) => row.serverId === "studio")!;
  await expect(
    f.commit([
      {
        kind: "import-host",
        source: {
          serverId: "studio",
          sourceSha256: "d".repeat(64),
          resolutionSha256: "e".repeat(64),
        },
        previousSourceSha256: null,
        expectedDomainRevision: domain.revision,
        entries: [
          {
            ...f.snapshot().entries[1],
            ref: { serverId: "studio", workspaceId: "child" },
            parent: { serverId: "owner", workspaceId: "a" },
          },
        ],
      },
    ]),
  ).rejects.toThrow("retirement_conflict");
});
it("does not let a put or a legacy writer bypass the retirement tombstone", async () => {
  const f = await fixture();
  await expect(
    f.commit([
      {
        kind: "put",
        entry: { ...f.snapshot().entries[0], archivedAt: "2026-11-19T18:00:00.000Z" },
      },
    ]),
  ).rejects.toThrow("canonical_retirement_reservation_required");
  await f.commit([f.reserve()]);
  await f.commit([
    {
      kind: "archive-retirement",
      operationId: f.operationId,
      archivedAt: "2026-11-19T18:00:00.000Z",
    },
  ]);
  await f.commit([{ kind: "complete-retirement", operationId: f.operationId }]);
  await expect(
    f.commit([{ kind: "put", entry: { ...f.snapshot().entries[0], archivedAt: null } }]),
  ).rejects.toThrow("canonical_retirement_reservation_required");
});

it("fences target navigation order and sort modes but permits unrelated project preferences", async () => {
  const f = await fixture();
  await f.commit([f.reserve()]);
  const navigation = f.snapshot().navigation!;
  for (const preferences of [
    { ...navigation.preferences, workspaceSort: "created" },
    { ...navigation.preferences, projectOrder: ["project"] },
    { ...navigation.preferences, workspaceSortModeByProject: { project: "activity" } },
    { ...navigation.preferences, workspaceOrderByProject: { project: ["owner:a"] } },
  ]) {
    await expect(
      f.commit([{ kind: "put-navigation", expectedRevision: navigation.revision, preferences }]),
    ).rejects.toThrow("retirement_conflict");
  }
  await f.commit([
    {
      kind: "put-navigation",
      expectedRevision: navigation.revision,
      preferences: {
        ...navigation.preferences,
        workspaceSortModeByProject: { unrelated: "alphabetical" },
      },
    },
  ]);
});

it("rejects a retirement from a future revision instead of accepting malformed persisted evidence", async () => {
  const f = await fixture();
  await f.commit([f.reserve()]);
  const malformed = structuredClone(f.snapshot());
  malformed.retirements![0].reservedRevision = malformed.stamp.revision + 1;
  expect(() => validateLayoutGraph(malformed)).toThrow("invalid_retirement_operation");
});

it("refuses retirement while importing without changing entries, receipts or phase", async () => {
  const f = await fixture(false, false);
  const before = f.snapshot();
  await expect(f.commit([f.reserve()])).rejects.toThrow("layout_importing");
  expect(await f.store.inspect()).toEqual(before);
});

it("refuses a known cross-owner ancestor rather than silently severing the edge", async () => {
  const f = await fixture();
  const domain = f.snapshot().ownerDomains!.find((row) => row.serverId === "studio")!;
  await f.commit([
    {
      kind: "import-host",
      previousSourceSha256: null,
      expectedDomainRevision: domain.revision,
      source: {
        serverId: "studio",
        sourceSha256: "d".repeat(64),
        resolutionSha256: "e".repeat(64),
      },
      entries: [{ ...f.snapshot().entries[1], ref: { serverId: "studio", workspaceId: "parent" } }],
    },
  ]);
  await f.commit([
    {
      kind: "put",
      entry: {
        ...f.snapshot().entries[0],
        pinPlacement: {
          parentWorkspaceKey: "studio:parent",
          siblingOrder: 0,
          revision: 1,
        },
        sectionIntent: { ...f.snapshot().entries[0].sectionIntent!, mode: "explicit" },
      },
    },
  ]);
  const before = f.snapshot();
  await expect(f.commit([f.reserve()])).rejects.toThrow("retirement_cross_owner_dependency");
  expect(await f.store.inspect()).toEqual(before);
});

it("RECOVERY create conflict identifies its fencing operation and retiring target", async () => {
  const f = await fixture();
  await f.commit([
    {
      kind: "put",
      entry: {
        ...f.snapshot().entries[0],
        parent: f.snapshot().entries[1].ref,
        sectionIntent: { ...f.snapshot().entries[0].sectionIntent!, mode: "explicit" },
      },
    },
  ]);
  await f.commit([f.reserve()]);
  const child = {
    ...f.snapshot().entries[1],
    ref: { serverId: "owner", workspaceId: "new-pinned-child" },
    parent: f.snapshot().entries[1].ref,
    pinnedAt: null,
    revision: 0,
  };
  try {
    await f.commit([{ kind: "put", entry: child }]);
    throw Error("fixture expected conflict");
  } catch (error) {
    expect(error).toMatchObject({ code: "retirement_conflict" });
    expect((error as Error).message).toContain(f.operationId);
    expect((error as Error).message).toContain("owner/a");
  }
  expect(f.snapshot().entries.some((row) => row.ref.workspaceId === "new-pinned-child")).toBe(
    false,
  );
});
