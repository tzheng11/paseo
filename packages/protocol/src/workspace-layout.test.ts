import { expect, test } from "vitest";
import {
  qualifyLegacyWorkspaceLayoutEntries,
  resolveEffectiveWorkspaceLayout,
  type WorkspaceLayoutEntry,
  type WorkspaceLayoutSnapshot,
} from "./workspace-layout.js";

const at = "2026-11-01T00:00:00.000Z";
function row(
  serverId: string,
  workspaceId: string,
  parent: string | null = null,
): WorkspaceLayoutEntry {
  return {
    ref: { serverId, workspaceId },
    projectId: "project",
    pinnedAt: null,
    superpinnedAt: null,
    parent: null,
    siblingOrder: 0,
    archivedAt: null,
    revision: 0,
    pinPlacement: { parentWorkspaceKey: parent, siblingOrder: 1024, revision: 1 },
  };
}
function fixture(): WorkspaceLayoutSnapshot {
  return {
    semanticsVersion: 2,
    ownerDomains: [],
    stamp: {
      authorityServerId: "authority",
      authorityId: "00000000-0000-4000-8000-000000000001",
      epoch: "00000000-0000-4000-8000-000000000002",
      phase: "active",
      revision: 1,
    },
    imports: [],
    entries: qualifyLegacyWorkspaceLayoutEntries([
      row("worker", "x"),
      { ...row("coordinator", "p"), pinnedAt: at, superpinnedAt: at },
      row("late", "y", "worker:x"),
      row("late", "z", "late:y"),
      { ...row("late", "personal", "worker:x"), pinnedAt: at },
    ]),
  };
}
function reparent(snapshot: WorkspaceLayoutSnapshot) {
  const source = snapshot.entries[0];
  source.pinPlacement = { parentWorkspaceKey: "coordinator:p", siblingOrder: 1024, revision: 2 };
  source.sectionIntent = { ...source.sectionIntent!, mode: "inherit" };
}

test("one reparent derives multilevel section membership without rewriting captured raw pins", () => {
  const snapshot = fixture();
  const before = structuredClone(snapshot.entries);
  reparent(snapshot);
  const effective = resolveEffectiveWorkspaceLayout(snapshot);
  for (const key of ["worker:x", "late:y", "late:z"])
    expect(effective.get(key)).toMatchObject({
      section: "superpinned",
      sectionSourceKey: "coordinator:p",
      pinnedAt: at,
      superpinnedAt: at,
    });
  expect(snapshot.entries.slice(1)).toEqual(before.slice(1));
  expect(snapshot.entries[0]).toMatchObject({ pinnedAt: null, superpinnedAt: null });
});

test("a dormant legacy cross-section edge keeps its personal section and raw relation", () => {
  const snapshot = fixture();
  reparent(snapshot);
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:personal")).toMatchObject({
    section: "pinned",
    parentWorkspaceKey: null,
    sectionSourceKey: "late:personal",
  });
  expect(snapshot.entries[4].pinPlacement?.parentWorkspaceKey).toBe("worker:x");
  expect(snapshot.entries[1]).toMatchObject({ pinnedAt: at, superpinnedAt: at });
});

test("immutable adoption baselines preserve delayed inheritance after an explicit root pin change", () => {
  const snapshot = fixture();
  const source = snapshot.entries[0];
  source.pinnedAt = at;
  source.superpinnedAt = at;
  source.sectionIntent = { ...source.sectionIntent!, mode: "explicit" };
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:y")?.section).toBe("superpinned");
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:personal")?.section).toBe("pinned");
});

test("archived links remain dormant and reactivate without changing stored pins", () => {
  const snapshot = fixture();
  reparent(snapshot);
  snapshot.entries[0].archivedAt = at;
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:y")).toMatchObject({
    section: "unpinned",
    parentWorkspaceKey: null,
  });
  snapshot.entries[0].archivedAt = null;
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:y")).toMatchObject({
    section: "superpinned",
    parentWorkspaceKey: "worker:x",
  });
});

test("unknown ancestry stays explicit while unrelated roots remain readable", () => {
  const snapshot = fixture();
  const late = snapshot.entries[2];
  late.pinPlacement = { parentWorkspaceKey: "unknown:parent", siblingOrder: 0, revision: 2 };
  late.sectionIntent = { ...late.sectionIntent!, mode: "inherit" };
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("late:z")).toMatchObject({
    section: null,
    unresolvedParentKey: "unknown:parent",
  });
  expect(resolveEffectiveWorkspaceLayout(snapshot).get("coordinator:p")?.section).toBe(
    "superpinned",
  );
});

test("dormant and inherited edges both participate in cycle refusal", () => {
  const snapshot = fixture();
  reparent(snapshot);
  snapshot.entries[1].pinPlacement = { parentWorkspaceKey: "late:z", siblingOrder: 0, revision: 2 };
  expect(() => resolveEffectiveWorkspaceLayout(snapshot)).toThrow("workspace_layout_cycle");
});
