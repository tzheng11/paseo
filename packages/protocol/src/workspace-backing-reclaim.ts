import { z } from "zod";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const BackingPath = z.string().min(1).max(4096);
export const WorkspaceBackingReclaimTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("retired"),
    path: BackingPath,
    workspaceId: z.string().min(1),
    retirementOperationId: z.string().uuid(),
    backingGeneration: Digest,
  }),
  z.object({ kind: z.literal("orphan"), path: BackingPath }),
]);
export const WorkspaceBackingReclaimInputSchema = z.object({
  target: WorkspaceBackingReclaimTargetSchema,
  releaseEvidence: Digest,
});
export const WorkspaceBackingReclaimPreviewSchema = z.object({
  target: WorkspaceBackingReclaimTargetSchema,
  eligible: z.boolean(),
  code: z.string().nullable(),
  generation: Digest.nullable(),
});
export const WorkspaceBackingReclaimOperationSchema = z.object({
  operationId: z.string().uuid(),
  ownerServerId: z.string(),
  target: WorkspaceBackingReclaimTargetSchema,
  generation: Digest,
  state: z.enum(["pending", "refused", "partial", "complete"]),
  terminal: z.boolean(),
  code: z.string().nullable(),
  removedDirectory: z.boolean(),
  receipt: z.object({ id: z.string(), requestSha256: Digest, resultSha256: Digest }).nullable(),
});
export const WorkspaceBackingReclaimBindingSchema = z.object({
  operationId: z.string().uuid(),
  generation: Digest,
  path: BackingPath,
  releaseEvidence: Digest,
  ownerReleased: z.literal(true),
  externalReferencesClear: z.literal(true),
});
export const WorkspaceBackingReclaimPreviewRequestSchema =
  WorkspaceBackingReclaimInputSchema.extend({
    type: z.literal("workspace.reclaim.preview.request"),
    requestId: z.string(),
  });
export const WorkspaceBackingReclaimPreviewResponseSchema = z.object({
  type: z.literal("workspace.reclaim.preview.response"),
  payload: z.object({ requestId: z.string(), preview: WorkspaceBackingReclaimPreviewSchema }),
});
export const WorkspaceBackingReclaimApplyRequestSchema = WorkspaceBackingReclaimInputSchema.extend({
  type: z.literal("workspace.reclaim.apply.request"),
  requestId: z.string(),
  operationId: z.string().uuid(),
  expectedGeneration: Digest,
});
export const WorkspaceBackingReclaimApplyResponseSchema = z.object({
  type: z.literal("workspace.reclaim.apply.response"),
  payload: z.object({ requestId: z.string(), operation: WorkspaceBackingReclaimOperationSchema }),
});
export const WorkspaceBackingReclaimStatusRequestSchema = z.object({
  type: z.literal("workspace.reclaim.get_status.request"),
  requestId: z.string(),
  operationId: z.string().uuid(),
});
export const WorkspaceBackingReclaimStatusResponseSchema = z.object({
  type: z.literal("workspace.reclaim.get_status.response"),
  payload: z.object({
    requestId: z.string(),
    operation: WorkspaceBackingReclaimOperationSchema.nullable(),
  }),
});
export const WorkspaceBackingReclaimVerifyRequestSchema =
  WorkspaceBackingReclaimBindingSchema.extend({
    type: z.literal("workspace.reclaim.verify.request"),
    requestId: z.string(),
  });
export const WorkspaceBackingReclaimVerifyResponseSchema = z.object({
  type: z.literal("workspace.reclaim.verify.response"),
  payload: z.object({ requestId: z.string(), valid: z.boolean(), code: z.string().nullable() }),
});
export type WorkspaceBackingReclaimTarget = z.infer<typeof WorkspaceBackingReclaimTargetSchema>;
export type WorkspaceBackingReclaimInput = z.infer<typeof WorkspaceBackingReclaimInputSchema>;
export type WorkspaceBackingReclaimOperation = z.infer<
  typeof WorkspaceBackingReclaimOperationSchema
>;
export type WorkspaceBackingReclaimBinding = z.infer<typeof WorkspaceBackingReclaimBindingSchema>;
