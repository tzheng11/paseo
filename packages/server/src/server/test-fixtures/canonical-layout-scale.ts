import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  type WorkspaceLayoutEntry,
  emptyWorkspaceNavigationPreferences,
} from "@getpaseo/protocol/workspace-layout";
import * as layoutProtocol from "@getpaseo/protocol/workspace-layout";
import { type PersistedWorkspaceRecord } from "../workspace-registry.js";
import { CanonicalWorkspaceRegistry } from "../workspace-layout-registry.js";
import { WorkspaceLayoutService } from "../workspace-layout-service.js";

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
export async function createLargeLayoutFixture(input: {
  home: string;
  phase: "importing" | "active";
  directories?: boolean;
}) {
  const { home, phase } = input;
  const derivedConfig = { ...config, semanticsVersion: 2 as const };
  const service = new WorkspaceLayoutService({
    home,
    serverId: "srv_hub",
    config: derivedConfig,
    failed: () => {},
  });
  const childPin = "2026-11-04T09:00:00.000Z";
  const records = Array.from({ length: 440 }, (_, index) => ({
    ...row(`large-${index}`),
    siblingOrder: index,
  }));
  records[0] = {
    ...records[0],
    pinnedAt: childPin,
    pinPlacement: { parentWorkspaceKey: "srv_b:large-440", siblingOrder: 0, revision: 1 },
  };
  records[1] = {
    ...records[1],
    pinnedAt: childPin,
    pinPlacement: { parentWorkspaceKey: "srv_unknown:missing", siblingOrder: 1, revision: 1 },
  };
  records[2] = { ...records[0], workspaceId: "large-2", archivedAt: at };
  const remote = Array.from({ length: 2869 }, (_, index) => ({
    ...row(`large-${index + 440}`),
    pinnedAt: index === 0 ? at : null,
  }));
  const initial = await service.initialize(derivedConfig);
  await service.commit({
    writerVersion: 2,
    requestId: "large-import",
    expected: initial.stamp,
    mutations: [
      ...[
        { serverId: "srv_a", records: records.slice(0, 439) },
        { serverId: "srv_b", records: remote },
      ].map(({ serverId, records: owned }) => ({
        kind: "import-host" as const,
        source: { serverId, sourceSha256: "a".repeat(64), resolutionSha256: "b".repeat(64) },
        previousSourceSha256: null,
        entries: layoutProtocol.qualifyLegacyWorkspaceLayoutEntries(
          owned.map((record) => canonical(record, serverId)),
        ),
      })),
      { kind: "declare-unknown-owner", serverId: "srv_unknown" },
      {
        kind: "put-navigation",
        expectedRevision: 0,
        preferences: emptyWorkspaceNavigationPreferences(),
        importResolution: { clientSources: [], resolutionSha256: "0".repeat(64) },
      },
    ],
  });
  const imported = await service.inspect();
  if (imported.entries.length !== 3308) throw new Error("wrong scale fixture size");
  if (phase === "active")
    await service.commit({
      writerVersion: 2,
      requestId: "large-activate",
      expected: imported.stamp,
      mutations: [
        {
          kind: "activate",
          requiredImports: imported.imports,
          requiredClientImports: [],
          requiredOwnerDomains: imported.ownerDomains,
        },
      ],
    });
  if (input.directories) {
    for (const record of records) record.cwd = path.join(home, "locals", record.workspaceId);
    await Promise.all(records.map((record) => mkdir(record.cwd, { recursive: true })));
  }
  const file = path.join(home, "large", "workspaces.json");
  await mkdir(path.dirname(file));
  await writeFile(file, JSON.stringify(records));
  const logger = createTestLogger();
  const value = new CanonicalWorkspaceRegistry(file, logger, service, "srv_a");
  await value.initialize();
  return { value, file, records, childPin, service, logger };
}

/** Advance real durable state without a protection subscriber warming the new index. */
export async function coldLayoutGeneration(
  fixture: Awaited<ReturnType<typeof createLargeLayoutFixture>>,
) {
  await fixture.value.close();
  const snapshot = await fixture.service.inspect();
  if (!snapshot.navigation) throw new Error("fixture navigation missing");
  await fixture.service.commit({
    writerVersion: 2,
    requestId: randomUUID(),
    expected: snapshot.stamp,
    mutations: [
      {
        kind: "put-navigation",
        expectedRevision: snapshot.navigation.revision,
        preferences: snapshot.navigation.preferences,
        ...(snapshot.stamp.phase === "importing"
          ? {
              importResolution: {
                clientSources: snapshot.navigation.clientSources,
                resolutionSha256: snapshot.navigation.resolutionSha256,
              },
            }
          : {}),
      },
    ],
  });
  // File-backed reads initialize lazily. Do not eagerly warm canonical projection here.
  fixture.value = new CanonicalWorkspaceRegistry(
    fixture.file,
    fixture.logger,
    fixture.service,
    "srv_a",
  );
}
