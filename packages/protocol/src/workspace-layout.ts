import { z } from "zod";

const IdSchema = z.string().min(1).max(512);
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.string().datetime({ offset: true });
const SectionSchema = z.enum(["unpinned", "pinned", "superpinned"]);
export const WorkspaceSectionIntentSchema = z.object({
  mode: z.enum(["legacy", "inherit", "explicit"]),
  baselineSection: SectionSchema,
  baselineParentWorkspaceKey: IdSchema.nullable(),
});
export const WorkspaceOwnerDomainSchema = z.object({
  serverId: IdSchema,
  state: z.enum(["unknown", "adopted"]),
  revision: RevisionSchema,
});

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
  semanticsVersion: z.literal(2).optional(),
});
export const WORKSPACE_LAYOUT_MODE_FILENAME = "workspace-layout-mode.json";
export const WorkspaceLayoutHomeMarkerSchema = WorkspaceLayoutConfigSchema.extend({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  destructiveRetirement: z.literal("refuse"),
}).refine(
  (marker) => marker.schemaVersion >= 2 === (marker.semanticsVersion === 2),
  "layout_semantics_marker_mismatch",
);
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
  sectionIntent: WorkspaceSectionIntentSchema.optional(),
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
export const WorkspaceRetirementTargetSchema = z.object({
  ref: WorkspaceReferenceSchema,
  revision: RevisionSchema,
});
export const WorkspaceRetirementSchema = z.object({
  operationId: z.string().uuid(),
  ownerServerId: IdSchema,
  backingGeneration: DigestSchema,
  targets: z.array(WorkspaceRetirementTargetSchema).min(1).max(10000),
  // Authority-derived dependency read set. Callers cannot choose which ancestors to fence.
  dependencies: z.array(WorkspaceRetirementTargetSchema),
  state: z.enum(["reserved", "archived", "complete"]),
  reservedRevision: RevisionSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type WorkspaceRetirement = z.infer<typeof WorkspaceRetirementSchema>;
export const WorkspaceLayoutSnapshotSchema = z.object({
  retirementVersion: z.literal(1).optional(),
  retirements: z.array(WorkspaceRetirementSchema).optional(),
  semanticsVersion: z.literal(2).optional(),
  ownerDomains: z.array(WorkspaceOwnerDomainSchema).optional(),
  stamp: WorkspaceLayoutStampSchema,
  entries: z.array(WorkspaceLayoutEntrySchema),
  imports: z.array(WorkspaceLayoutImportSourceSchema),
  clientImports: z.array(WorkspaceLayoutClientImportSchema).optional(),
  navigation: WorkspaceNavigationSchema.nullable().optional(),
});

export const WorkspaceLayoutMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reserve-retirement"),
    operationId: z.string().uuid(),
    ownerServerId: IdSchema,
    backingGeneration: DigestSchema,
    targets: z.array(WorkspaceRetirementTargetSchema).min(1).max(10000),
  }),
  z.object({
    kind: z.literal("archive-retirement"),
    operationId: z.string().uuid(),
    archivedAt: TimestampSchema,
  }),
  z.object({ kind: z.literal("complete-retirement"), operationId: z.string().uuid() }),
  z.object({ kind: z.literal("put"), entry: WorkspaceLayoutEntrySchema }),
  z.object({
    kind: z.literal("activate"),
    requiredImports: z.array(WorkspaceLayoutImportSourceSchema).min(1),
    requiredClientImports: z.array(WorkspaceLayoutClientSourceSchema).optional(),
    requiredOwnerDomains: z.array(WorkspaceOwnerDomainSchema).optional(),
  }),
  z.object({ kind: z.literal("declare-unknown-owner"), serverId: IdSchema }),
  z.object({
    kind: z.literal("import-host"),
    source: WorkspaceLayoutImportSourceSchema,
    // A replacement import must bind the previous source as well as the CAS.
    previousSourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    entries: z.array(WorkspaceLayoutEntrySchema),
    expectedDomainRevision: RevisionSchema.optional(),
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
  writerVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  requestId: z.string().min(1).max(256),
  expected: WorkspaceLayoutStampSchema,
  mutations: z.array(WorkspaceLayoutMutationSchema).min(1).max(10000),
});
export const WorkspaceLayoutReceiptSchema = z.object({
  requestId: z.string(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stamp: WorkspaceLayoutStampSchema,
});
export const WorkspaceRetirementOutcomeSchema = z.object({
  operationId: z.string().uuid(),
  state: z.enum(["complete", "partial"]),
  code: z.string().optional(),
  receipt: WorkspaceLayoutReceiptSchema.optional(),
});
export const WorkspaceArchiveOutcomeSchema = z.object({
  archivedAgentIds: z.array(z.string()).optional(),
  archivedWorkspaceIds: z.array(z.string()).optional(),
  removedDirectory: z.boolean().optional(),
  slotKept: z.boolean().optional(),
  directoryLeftBehind: z.object({ path: z.string(), reason: z.string() }).optional(),
  retirement: WorkspaceRetirementOutcomeSchema.optional(),
});
export const WorkspaceLayoutInspectRequestSchema = z.object({
  type: z.literal("workspace.layout.inspect.request"),
  requestId: z.string(),
  observe: z.boolean().optional(),
  retirementVersion: z.literal(1).optional(),
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

export type WorkspaceLayoutSection = z.infer<typeof SectionSchema>;
export interface EffectiveWorkspaceLayout {
  section: WorkspaceLayoutSection | null;
  parentWorkspaceKey: string | null;
  sectionSourceKey: string | null;
  unresolvedParentKey: string | null;
  pinnedAt: string | null;
  superpinnedAt: string | null;
}

export function workspaceLayoutSection(
  entry: Pick<WorkspaceLayoutEntry, "pinnedAt" | "superpinnedAt">,
): WorkspaceLayoutSection {
  if (entry.superpinnedAt) return "superpinned";
  return entry.pinnedAt ? "pinned" : "unpinned";
}

export function workspaceLayoutParentKey(entry: WorkspaceLayoutEntry): string | null {
  if (entry.pinPlacement) return entry.pinPlacement.parentWorkspaceKey;
  return entry.parent ? `${entry.parent.serverId}:${entry.parent.workspaceId}` : null;
}

/** Captured raw section/edge provenance stays immutable when later moves or root pins change intent. */
export function qualifyLegacyWorkspaceLayoutEntries(
  entries: readonly WorkspaceLayoutEntry[],
): WorkspaceLayoutEntry[] {
  return entries.map((entry) => ({
    ...entry,
    sectionIntent: entry.sectionIntent ?? {
      mode: "legacy",
      baselineSection: workspaceLayoutSection(entry),
      baselineParentWorkspaceKey: workspaceLayoutParentKey(entry),
    },
  }));
}

/** One graph projection for daemon and client. Missing owners stay unknown; no descendant write is needed. */
export function resolveEffectiveWorkspaceLayout(
  snapshot: WorkspaceLayoutSnapshot,
): Map<string, EffectiveWorkspaceLayout> {
  const entries = new Map(
    snapshot.entries.map((entry) => [`${entry.ref.serverId}:${entry.ref.workspaceId}`, entry]),
  );
  if (entries.size !== snapshot.entries.length) throw new Error("duplicate_workspace_identity");
  const resolved = new Map<string, EffectiveWorkspaceLayout>();
  for (const key of entries.keys()) {
    const path: string[] = [];
    const visiting = new Set<string>();
    let current: string | null = key;
    while (current !== null && !resolved.has(current)) {
      if (visiting.has(current)) throw new Error("workspace_layout_cycle");
      visiting.add(current);
      const entry = entries.get(current);
      if (!entry) {
        resolved.set(current, {
          section: null,
          parentWorkspaceKey: null,
          sectionSourceKey: null,
          unresolvedParentKey: current,
          pinnedAt: null,
          superpinnedAt: null,
        });
        break;
      }
      path.push(current);
      current = workspaceLayoutParentKey(entry);
    }
    for (const item of path.toReversed()) {
      const entry = entries.get(item)!;
      const parentKey = workspaceLayoutParentKey(entry);
      const parent = parentKey ? entries.get(parentKey) : undefined;
      const parentView = parentKey ? resolved.get(parentKey) : undefined;
      resolved.set(item, effectiveLayoutEntry(snapshot, entry, item, parent, parentView));
    }
  }
  return new Map([...entries.keys()].map((key) => [key, resolved.get(key)!]));
}

function effectiveLayoutEntry(
  snapshot: WorkspaceLayoutSnapshot,
  entry: WorkspaceLayoutEntry,
  key: string,
  parent: WorkspaceLayoutEntry | undefined,
  parentView: EffectiveWorkspaceLayout | undefined,
): EffectiveWorkspaceLayout {
  const intent = entry.sectionIntent;
  const parentKey = workspaceLayoutParentKey(entry);
  const activeParent = parent && !parent.archivedAt && !entry.archivedAt;
  const inherits =
    snapshot.semanticsVersion === 2 && activeParent && inheritsWorkspaceSection(entry, parent);
  const unresolvedParentKey = parentView?.unresolvedParentKey ?? null;
  let section: WorkspaceLayoutSection | null = workspaceLayoutSection(entry);
  let sectionSourceKey: string | null = key;
  let pinnedAt = entry.pinnedAt;
  let superpinnedAt = entry.superpinnedAt;
  if (inherits && parentView) {
    section = parentView.section;
    sectionSourceKey = parentView.sectionSourceKey;
    pinnedAt = parentView.pinnedAt;
    superpinnedAt = parentView.superpinnedAt;
  } else if (
    !parent &&
    parentKey &&
    intent?.mode !== "explicit" &&
    snapshot.semanticsVersion === 2
  ) {
    section = null;
    sectionSourceKey = null;
  }
  const visibleParent = activeParent && section !== null && section === parentView?.section;
  return {
    section,
    sectionSourceKey,
    pinnedAt,
    superpinnedAt,
    parentWorkspaceKey: visibleParent ? parentKey : null,
    unresolvedParentKey,
  };
}

function inheritsWorkspaceSection(
  entry: WorkspaceLayoutEntry,
  parent: WorkspaceLayoutEntry,
): boolean {
  const intent = entry.sectionIntent;
  if (intent?.mode === "inherit") return true;
  return (
    intent?.mode === "legacy" &&
    intent.baselineParentWorkspaceKey === workspaceLayoutParentKey(entry) &&
    intent.baselineSection === parent.sectionIntent?.baselineSection
  );
}

interface WorkspaceSectionChange {
  entry: WorkspaceLayoutEntry;
  effective: EffectiveWorkspaceLayout;
  inherit: boolean;
  section: WorkspaceLayoutSection;
  now: string;
}

export function withWorkspaceSectionIntent(input: WorkspaceSectionChange): WorkspaceLayoutEntry {
  if (!input.entry.sectionIntent) throw new Error("section_intent_required");
  let pinnedAt = input.entry.pinnedAt;
  let superpinnedAt = input.entry.superpinnedAt;
  if (!input.inherit) {
    pinnedAt = input.section === "unpinned" ? null : (input.effective.pinnedAt ?? input.now);
    superpinnedAt =
      input.section === "superpinned" ? (input.effective.superpinnedAt ?? input.now) : null;
  }
  return {
    ...input.entry,
    pinnedAt,
    superpinnedAt,
    sectionIntent: { ...input.entry.sectionIntent, mode: input.inherit ? "inherit" : "explicit" },
  };
}

/** Native operations that can create or mutate hierarchy; old clients must not launder legacy intent. */
export const NATIVE_WORKSPACE_LAYOUT_WRITER_REQUESTS = new Set<string>([
  "workspace.pin.set.request",
  "workspace.superpin.set.request",
  "workspace.pin.placement.set.request",
  "workspace.move.request",
  "workspace.create.request",
  "create_paseo_worktree_request",
  "open_project_request",
  "agent.create.request",
  "create_agent_request",
  "import_agent_request",
  "hub.execution.agent.create.request",
  "workspace.recovery.restore.request",
  "refresh_agent_request",
]);
