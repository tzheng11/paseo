import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  decodeLegacyWorkspaceLayout,
  decodeLegacySidebarLayout,
  decodeLegacySidebarViewOrdering,
} from "./workspace-layout-import.js";

const at = "2026-11-04T10:00:00.000Z";
const base = { workspaceId: "one", projectId: "project", pinnedAt: null, archivedAt: null };
const encode = (records: unknown[]) => Buffer.from(JSON.stringify(records));

test("the separate sidebar-view source contributes global ordering and never client filters or pin flags", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      version: 8,
      state: { workspaceSort: "lastPrompt", hostFilters: ["srv_a"], groupMode: "project" },
    }),
  );
  expect(decodeLegacySidebarViewOrdering(bytes).preferences).toEqual({
    workspaceSort: "lastPrompt",
  });
  const old = Buffer.from(
    JSON.stringify({
      version: 1,
      state: { workspaceSort: "lastPrompt", groupModeByServerId: { srv_a: "status" } },
    }),
  );
  expect(decodeLegacySidebarViewOrdering(old).preferences).toEqual({ workspaceSort: "created" });
  expect(() =>
    decodeLegacySidebarViewOrdering(Buffer.from(JSON.stringify({ version: 9, state: {} }))),
  ).toThrow();
  expect(() =>
    decodeLegacySidebarViewOrdering(
      Buffer.from(JSON.stringify({ version: 8, state: { workspaceSort: "unknown" } })),
    ),
  ).toThrow();
});

test("client import preserves version3 view order and dormant trees without promoting order membership into pins", () => {
  const state = {
    projectOrder: ["view with space "],
    pinnedWorkspaceOrder: ["srv_a:one"],
    superpinnedWorkspaceOrder: ["srv_b:one"],
    workspaceOrderByProject: { "view with space ": ["srv_b:one", "srv_a:one"] },
    workspaceSortModeByProject: { "view with space ": "activity" },
    pinnedWorkspaceSortMode: "alphabetical",
    pinnedWorkspaceTree: {
      "srv_a:one": { parentWorkspaceKey: "srv_b:old-parent", siblingOrder: 8 },
    },
  };
  const bytes = Buffer.from(JSON.stringify({ state, version: 3 }));
  const decoded = decodeLegacySidebarLayout(bytes);
  expect(decoded.preferences).toEqual(
    Object.fromEntries(Object.entries(state).filter(([key]) => key !== "pinnedWorkspaceTree")),
  );
  expect(decoded.pinnedWorkspaceTree).toEqual(state.pinnedWorkspaceTree);
  expect(decoded.sourceSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(decoded.preferences).not.toHaveProperty("pinnedAt");
});

test("version1 client import uses the app's exact scoped-key migration and refuses corrupt or future inputs", () => {
  const saved = {
    version: 1,
    state: {
      projectOrder: [" view ", "view"],
      workspaceOrderByServerAndProject: { "srv_a::view": ["one", "srv_a:two"] },
    },
  };
  const decoded = decodeLegacySidebarLayout(Buffer.from(JSON.stringify(saved)));
  expect(decoded.preferences.projectOrder).toEqual(["view"]);
  expect(decoded.preferences.workspaceOrderByProject).toEqual({ view: ["srv_a:one", "srv_a:two"] });
  for (const bad of [
    { ...saved, version: 4 },
    { ...saved, state: { ...saved.state, unknownFutureField: true } },
    {
      ...saved,
      state: { ...saved.state, pinnedWorkspaceTree: { "srv_a:one": { siblingOrder: "bad" } } },
    },
  ])
    expect(() => decodeLegacySidebarLayout(Buffer.from(JSON.stringify(bad)))).toThrow();
});

test("the whole upstream014 disk profile decodes unsupported fields without inventing pins or ranks", () => {
  const bytes = encode([base, { ...base, workspaceId: "archived", pinnedAt: at, archivedAt: at }]);
  const result = decodeLegacyWorkspaceLayout({ serverId: "srv_a", bytes, profile: "upstream-014" });
  expect(result.sourceSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.entries).toEqual([
    {
      ref: { serverId: "srv_a", workspaceId: "one" },
      projectId: "project",
      pinnedAt: null,
      superpinnedAt: null,
      parent: null,
      siblingOrder: null,
      pinPlacement: null,
      archivedAt: null,
      revision: 0,
    },
    {
      ref: { serverId: "srv_a", workspaceId: "archived" },
      projectId: "project",
      pinnedAt: at,
      superpinnedAt: null,
      parent: null,
      siblingOrder: null,
      pinPlacement: null,
      archivedAt: at,
      revision: 0,
    },
  ]);
});

test("rich disk data retains timestamps, finite ranks and dormant cross-host links exactly", () => {
  const rich = {
    ...base,
    pinnedAt: at,
    superpinnedAt: at,
    parentWorkspaceId: "parent",
    siblingOrder: 42,
    pinPlacement: { parentWorkspaceKey: "srv_b:parent", siblingOrder: -17, revision: 3 },
  };
  const result = decodeLegacyWorkspaceLayout({
    serverId: "srv_a",
    bytes: encode([rich]),
    profile: "impower-layout-v1",
  });
  expect(result.entries[0]).toMatchObject({
    pinnedAt: at,
    superpinnedAt: at,
    siblingOrder: 42,
    parent: { serverId: "srv_a", workspaceId: "parent" },
    pinPlacement: rich.pinPlacement,
  });
  const noOverride = { ...rich, pinPlacement: undefined };
  expect(
    decodeLegacyWorkspaceLayout({
      serverId: "srv_a",
      bytes: encode([noOverride]),
      profile: "impower-layout-v1",
    }).entries[0].pinPlacement,
  ).toBeNull();
});

test("missing pin observations, mixed producer profiles and invalid ranks never decode as unpinned", () => {
  const malformed = [
    [base, { ...base, workspaceId: "two", pinnedAt: undefined }],
    [base, { ...base, workspaceId: "two", superpinnedAt: null }],
    [{ ...base, pinnedAt: "not-a-time" }],
    [base, base],
  ];
  for (const records of malformed)
    expect(() =>
      decodeLegacyWorkspaceLayout({
        serverId: "srv_a",
        bytes: encode(records),
        profile: "upstream-014",
      }),
    ).toThrow();
  const rich = { ...base, parentWorkspaceId: null, siblingOrder: 5 };
  expect(() =>
    decodeLegacyWorkspaceLayout({
      serverId: "srv_a",
      bytes: encode([rich]),
      profile: "impower-layout-v1",
    }),
  ).toThrow();
  expect(() =>
    decodeLegacyWorkspaceLayout({
      serverId: "srv_a",
      bytes: encode([{ ...rich, superpinnedAt: null, siblingOrder: "5" }]),
      profile: "impower-layout-v1",
    }),
  ).toThrow();
});
