import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { decodeLegacyWorkspaceLayout } from "./workspace-layout-import.js";

const at = "2026-11-04T10:00:00.000Z";
const base = { workspaceId: "one", projectId: "project", pinnedAt: null, archivedAt: null };
const encode = (records: unknown[]) => Buffer.from(JSON.stringify(records));

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
