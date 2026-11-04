import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WorkspacePinPlacementSchema,
  workspaceReferenceKey,
  type WorkspaceLayoutEntry,
} from "@getpaseo/protocol/workspace-layout";
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
