import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WorkspacePinPlacementSchema,
  WorkspaceNavigationPreferencesSchema,
  workspaceReferenceKey,
  type WorkspaceLayoutEntry,
} from "@getpaseo/protocol/workspace-layout";
import {
  LegacySidebarOrderStateSchema,
  migrateSidebarOrderState,
} from "@getpaseo/protocol/sidebar-order";
import { WorkspaceLayoutRefusal } from "./workspace-layout-store.js";

const common = z.object({
  workspaceId: z.string().min(1).max(512),
  projectId: z.string().min(1).max(512),
  pinnedAt: z.string().datetime({ offset: true }).nullable(),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
});
const upstream014 = common.extend({
  superpinnedAt: z.never().optional(),
  parentWorkspaceId: z.never().optional(),
  siblingOrder: z.never().optional(),
  pinPlacement: z.never().optional(),
});
const impowerLayout = common.extend({
  superpinnedAt: z.string().datetime({ offset: true }).nullable(),
  parentWorkspaceId: z.string().min(1).nullable(),
  siblingOrder: z.number().finite(),
  pinPlacement: WorkspacePinPlacementSchema.optional(),
});

export type LegacyWorkspaceLayoutProfile = "upstream-014" | "impower-layout-v1";

/** Only the ordering part is canonical; original filter/grouping bytes remain import provenance. */
export function decodeLegacySidebarViewOrdering(bytes: Uint8Array) {
  const group = z.enum(["none", "project", "status", "label"]);
  const saved = z
    .strictObject({
      version: z.number().int().min(0).max(8),
      state: z.strictObject({
        workspaceSort: z.enum(["manual", "created", "lastPrompt"]).optional(),
        showBackground: z.boolean().optional(),
        groupMode: group.optional(),
        hostFilters: z.array(z.string()).optional(),
        hostFilter: z.string().nullable().optional(),
        projectFilters: z.array(z.string()).optional(),
        groupModeByServerId: z.record(z.string(), group).optional(),
        labelFilter: z.object({ labels: z.array(z.string()) }).optional(),
      }),
    })
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  // This is the exact existing migrateSidebarViewState ordering rule.
  const legacyGrouping = Object.values(saved.state.groupModeByServerId ?? {}).length > 0;
  const workspaceSort = legacyGrouping
    ? ("created" as const)
    : (saved.state.workspaceSort ?? "created");
  return {
    version: saved.version,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    preferences: { workspaceSort },
    pinnedWorkspaceTree: {},
  };
}

/** Use the same versioned interpretation as the app, but refuse malformed retained data before migration. */
export function decodeLegacySidebarLayout(bytes: Uint8Array) {
  const saved = z
    .strictObject({ version: z.number().int().min(0).max(3), state: LegacySidebarOrderStateSchema })
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const { pinnedWorkspaceTree, ...interpreted } = migrateSidebarOrderState(
    saved.state,
    saved.version,
  );
  return {
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    version: saved.version,
    preferences: WorkspaceNavigationPreferencesSchema.parse(interpreted),
    pinnedWorkspaceTree,
  };
}

/** Decode retained disk bytes only. The caller separately binds producer provenance and conflict rulings. */
export function decodeLegacyWorkspaceLayout(input: {
  serverId: string;
  bytes: Uint8Array;
  profile: LegacyWorkspaceLayoutProfile;
}): {
  profile: LegacyWorkspaceLayoutProfile;
  sourceSha256: string;
  entries: WorkspaceLayoutEntry[];
} {
  z.string().min(1).max(512).parse(input.serverId);
  z.enum(["upstream-014", "impower-layout-v1"]).parse(input.profile);
  const sourceSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const records = z
    .array(z.unknown())
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)));
  const entries = records.map((raw): WorkspaceLayoutEntry => {
    if (input.profile === "upstream-014") {
      const record = upstream014.parse(raw);
      return {
        ref: { serverId: input.serverId, workspaceId: record.workspaceId },
        projectId: record.projectId,
        pinnedAt: record.pinnedAt,
        superpinnedAt: null,
        parent: null,
        siblingOrder: null,
        pinPlacement: null,
        archivedAt: record.archivedAt,
        revision: 0,
      };
    }
    if (input.profile !== "impower-layout-v1")
      throw new WorkspaceLayoutRefusal("unsupported_import_decoder");
    const record = impowerLayout.parse(raw);
    return {
      ref: { serverId: input.serverId, workspaceId: record.workspaceId },
      projectId: record.projectId,
      pinnedAt: record.pinnedAt,
      superpinnedAt: record.superpinnedAt,
      parent: record.parentWorkspaceId
        ? { serverId: input.serverId, workspaceId: record.parentWorkspaceId }
        : null,
      siblingOrder: record.siblingOrder,
      pinPlacement: record.pinPlacement ?? null,
      archivedAt: record.archivedAt,
      revision: 0,
    };
  });
  if (new Set(entries.map((entry) => workspaceReferenceKey(entry.ref))).size !== entries.length)
    throw new WorkspaceLayoutRefusal("duplicate_workspace_identity");
  return { profile: input.profile, sourceSha256, entries };
}
