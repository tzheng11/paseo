import { z } from "zod";

const IdSchema = z.string().min(1).max(512);
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.string().datetime({ offset: true });

export const WorkspaceReferenceSchema = z.object({
  serverId: IdSchema,
  workspaceId: IdSchema,
});
export const WorkspaceLayoutIdentitySchema = z.object({
  authorityServerId: IdSchema,
  authorityId: z.string().uuid(),
  epoch: z.string().uuid(),
});
export const WorkspaceLayoutConfigSchema = WorkspaceLayoutIdentitySchema.extend({
  role: z.enum(["authority", "replica"]),
  // SHA256 of the UTF-8 daemonPublicKeyB64 string in the key-bound relay offer.
  authorityKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const WORKSPACE_LAYOUT_MODE_FILENAME = "workspace-layout-mode.json";
export const WorkspaceLayoutHomeMarkerSchema = WorkspaceLayoutConfigSchema.extend({
  schemaVersion: z.literal(1),
  destructiveRetirement: z.literal("refuse"),
});
export const WorkspaceLayoutStampSchema = WorkspaceLayoutIdentitySchema.extend({
  revision: RevisionSchema,
  phase: z.enum(["importing", "active"]),
});
export const WorkspaceLayoutStatusSchema = WorkspaceLayoutConfigSchema.extend({
  stamp: WorkspaceLayoutStampSchema.nullable(),
  synchronized: z.boolean(),
});
export const WorkspacePinPlacementSchema = z.object({
  parentWorkspaceKey: z.string().min(1).max(512).nullable(),
  siblingOrder: z.number().finite(),
  revision: RevisionSchema,
});

// Pin timestamps are required, including explicit null. A legacy omitted value
// is an unresolved import input, never evidence that a workspace is unpinned.
export const WorkspaceLayoutEntrySchema = z.object({
  ref: WorkspaceReferenceSchema,
  projectId: IdSchema,
  pinnedAt: TimestampSchema.nullable(),
  superpinnedAt: TimestampSchema.nullable(),
  parent: WorkspaceReferenceSchema.nullable(),
  // null preserves an older producer's unranked/name-sorted position.
  siblingOrder: z.number().finite().nullable(),
  pinPlacement: WorkspacePinPlacementSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
});
export const WorkspaceLayoutImportSourceSchema = z.object({
  serverId: IdSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Includes any client-order/conflict rulings used by the explicit import.
  resolutionSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NavigationKeySchema = z
  .string()
  .min(3)
  .max(1024)
  .regex(/^[^:]+:.+$/);
export const WorkspaceNavigationPreferencesSchema = z.object({
  // Optional on the wire for older experimental readers; active stores require it.
  workspaceSort: z.enum(["manual", "created", "lastPrompt"]).optional(),
  projectOrder: z.array(IdSchema),
  pinnedWorkspaceOrder: z.array(NavigationKeySchema),
  superpinnedWorkspaceOrder: z.array(NavigationKeySchema),
  pinnedWorkspaceSortMode: z.enum(["manual", "alphabetical", "activity"]),
  workspaceOrderByProject: z.record(IdSchema, z.array(NavigationKeySchema)),
  workspaceSortModeByProject: z.record(IdSchema, z.enum(["manual", "alphabetical", "activity"])),
});
export const WorkspaceLayoutClientSourceSchema = z.object({
  sourceId: IdSchema,
  sourceSha256: DigestSchema,
  resolutionSha256: DigestSchema,
});
export const WorkspaceLayoutClientImportSchema = z.object({
  source: WorkspaceLayoutClientSourceSchema,
  preferences: WorkspaceNavigationPreferencesSchema.partial(),
  // Historical client edges are provenance. Active links belong to entries.
  pinnedWorkspaceTree: z.record(
    NavigationKeySchema,
    WorkspacePinPlacementSchema.omit({ revision: true }),
  ),
});
export const WorkspaceNavigationSchema = z.object({
  revision: RevisionSchema,
  preferences: WorkspaceNavigationPreferencesSchema,
  clientSources: z.array(WorkspaceLayoutClientSourceSchema),
  resolutionSha256: DigestSchema,
});
export const WorkspaceLayoutSnapshotSchema = z.object({
  stamp: WorkspaceLayoutStampSchema,
  entries: z.array(WorkspaceLayoutEntrySchema),
  imports: z.array(WorkspaceLayoutImportSourceSchema),
  clientImports: z.array(WorkspaceLayoutClientImportSchema).optional(),
  navigation: WorkspaceNavigationSchema.nullable().optional(),
});

export const WorkspaceLayoutMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("put"), entry: WorkspaceLayoutEntrySchema }),
  z.object({
    kind: z.literal("activate"),
    requiredImports: z.array(WorkspaceLayoutImportSourceSchema).min(1),
    requiredClientImports: z.array(WorkspaceLayoutClientSourceSchema).optional(),
  }),
  z.object({
    kind: z.literal("import-host"),
    source: WorkspaceLayoutImportSourceSchema,
    // A replacement import must bind the previous source as well as the CAS.
    previousSourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    entries: z.array(WorkspaceLayoutEntrySchema),
  }),
  z.object({
    kind: z.literal("import-client"),
    input: WorkspaceLayoutClientImportSchema,
    previousSourceSha256: DigestSchema.nullable(),
  }),
  z.object({
    kind: z.literal("put-navigation"),
    expectedRevision: RevisionSchema,
    preferences: WorkspaceNavigationPreferencesSchema,
    importResolution: z
      .object({
        clientSources: z.array(WorkspaceLayoutClientSourceSchema),
        resolutionSha256: DigestSchema,
      })
      .optional(),
  }),
]);
export const WorkspaceLayoutCommitSchema = z.object({
  requestId: z.string().min(1).max(256),
  expected: WorkspaceLayoutStampSchema,
  mutations: z.array(WorkspaceLayoutMutationSchema).min(1).max(10000),
});
export const WorkspaceLayoutReceiptSchema = z.object({
  requestId: z.string(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stamp: WorkspaceLayoutStampSchema,
});
export const WorkspaceLayoutInspectRequestSchema = z.object({
  type: z.literal("workspace.layout.inspect.request"),
  requestId: z.string(),
  observe: z.boolean().optional(),
});
export const WorkspaceLayoutReceiptRequestSchema = z.object({
  type: z.literal("workspace.layout.receipt.request"),
  requestId: z.string(),
  mutationRequestId: z.string().min(1).max(256),
});
export const WorkspaceLayoutReceiptResponseSchema = z.object({
  type: z.literal("workspace.layout.receipt.response"),
  payload: z.object({ requestId: z.string(), receipt: WorkspaceLayoutReceiptSchema.nullable() }),
});
export const WorkspaceLayoutInitializeRequestSchema = z.object({
  type: z.literal("workspace.layout.initialize.request"),
  requestId: z.string(),
  identity: WorkspaceLayoutIdentitySchema,
});
export const WorkspaceLayoutCommitRequestSchema = WorkspaceLayoutCommitSchema.extend({
  type: z.literal("workspace.layout.commit.request"),
});
export const WorkspaceLayoutInspectResponseSchema = z.object({
  type: z.literal("workspace.layout.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    snapshot: WorkspaceLayoutSnapshotSchema,
    subscriptionId: z.string().optional(),
  }),
});
export const WorkspaceLayoutChangedSchema = z.object({
  type: z.literal("workspace.layout.changed"),
  payload: z.object({ subscriptionId: z.string(), snapshot: WorkspaceLayoutSnapshotSchema }),
});
export const WorkspaceLayoutInitializeResponseSchema = z.object({
  type: z.literal("workspace.layout.initialize.response"),
  payload: z.object({ requestId: z.string(), snapshot: WorkspaceLayoutSnapshotSchema }),
});
export const WorkspaceLayoutCommitResponseSchema = z.object({
  type: z.literal("workspace.layout.commit.response"),
  payload: z.object({ requestId: z.string(), receipt: WorkspaceLayoutReceiptSchema }),
});

export type WorkspaceReference = z.infer<typeof WorkspaceReferenceSchema>;
export type WorkspaceLayoutIdentity = z.infer<typeof WorkspaceLayoutIdentitySchema>;
export type WorkspaceLayoutConfig = z.infer<typeof WorkspaceLayoutConfigSchema>;
export type WorkspaceLayoutStamp = z.infer<typeof WorkspaceLayoutStampSchema>;
export type WorkspaceLayoutEntry = z.infer<typeof WorkspaceLayoutEntrySchema>;
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
export type WorkspaceLayoutCommit = z.infer<typeof WorkspaceLayoutCommitSchema>;
export type WorkspaceLayoutMutation = z.infer<typeof WorkspaceLayoutMutationSchema>;
export type WorkspaceLayoutReceipt = z.infer<typeof WorkspaceLayoutReceiptSchema>;
export type WorkspaceNavigationPreferences = z.infer<typeof WorkspaceNavigationPreferencesSchema>;
export type WorkspaceNavigation = z.infer<typeof WorkspaceNavigationSchema>;
export type WorkspaceLayoutClientImport = z.infer<typeof WorkspaceLayoutClientImportSchema>;

export function emptyWorkspaceNavigationPreferences(): WorkspaceNavigationPreferences {
  return {
    workspaceSort: "manual",
    projectOrder: [],
    pinnedWorkspaceOrder: [],
    superpinnedWorkspaceOrder: [],
    pinnedWorkspaceSortMode: "manual",
    workspaceOrderByProject: {},
    workspaceSortModeByProject: {},
  };
}

export function workspaceReferenceKey(ref: WorkspaceReference): string {
  return JSON.stringify([ref.serverId, ref.workspaceId]);
}

/** Stable input for request digests on every client/runtime. */
export function canonicalLayoutJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareLayoutKeys(a, b)))
      : item,
  );
}

function compareLayoutKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function parseWorkspaceNavigationKey(key: string): WorkspaceReference {
  const separator = key.indexOf(":");
  if (separator <= 0) throw new Error("Invalid host-qualified workspace key");
  return WorkspaceReferenceSchema.parse({
    serverId: key.slice(0, separator),
    workspaceId: key.slice(separator + 1),
  });
}
