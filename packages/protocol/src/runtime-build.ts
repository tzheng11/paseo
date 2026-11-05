import { z } from "zod";

export const RuntimeBuildIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  distributionVersion: z.string().min(1),
  upstreamVersion: z.string().min(1),
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDirty: z.boolean(),
  lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RuntimeBuildIdentity = z.infer<typeof RuntimeBuildIdentitySchema>;

export const RuntimeWriteIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  formatFamily: z.literal("paseo-impower-015"),
  minimumRecoveryVersion: z.literal("0.15.0-impower"),
  generation: z.string().uuid(),
  firstIntentAt: z.string().datetime({ offset: true }),
  firstWriter: z.strictObject({
    version: z.string().min(1),
    build: RuntimeBuildIdentitySchema.nullable(),
  }),
});
export type RuntimeWriteIntent = z.infer<typeof RuntimeWriteIntentSchema>;
