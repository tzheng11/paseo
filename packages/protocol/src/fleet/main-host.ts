import { z } from "zod";

export const MAIN_HOST_MAX_GENERATION = 2_147_483_647;
const GenerationSchema = z.number().int().min(0).max(MAIN_HOST_MAX_GENERATION);

export const MainHostProvenanceSchema = z.strictObject({
  principalId: z.string().min(1),
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
  serverId: z.string().min(1),
  clientType: z.enum(["mobile", "browser", "cli", "mcp", "hub", "unknown"]),
});

export const MainHostAllocationSchema = z.strictObject({
  allocationId: z.string().uuid(),
  allocatorServerId: z.string().min(1),
  requestId: z.string().min(1),
  mainHost: z.string().min(1).nullable(),
  generation: GenerationSchema.min(1),
  previousMainHost: z.string().min(1).nullable(),
  undoOf: z.string().uuid().nullable(),
  setAt: z.string().datetime(),
  setBy: MainHostProvenanceSchema,
});

export const MainHostChoiceSchema = MainHostAllocationSchema.extend({
  receipt: z.string().min(1),
});

export const MainHostDeliverySchema = z.strictObject({
  allocationId: z.string().uuid(),
  confirmedAt: z.string().datetime(),
  confirmedBy: MainHostProvenanceSchema,
});

export const MainHostStateSchema = z.strictObject({
  choice: MainHostChoiceSchema.nullable(),
  held: z.boolean(),
  delivery: MainHostDeliverySchema.nullable(),
});

export const MainHostSetInputSchema = z.strictObject({
  mainHost: z.string().min(1).nullable(),
  expectedGeneration: GenerationSchema,
  requestId: z.string().min(1),
});

export const MainHostApplyInputSchema = z.strictObject({
  choice: MainHostChoiceSchema,
  allocatorPublicKey: z.string().min(1).optional(),
  expectedLocalGeneration: GenerationSchema,
  confirmation: z.strictObject({ allocationId: z.string().uuid() }).nullable(),
  requestId: z.string().min(1),
});

export const MainHostGetRequestSchema = z.object({
  type: z.literal("fleet.main_host.get.request"),
  requestId: z.string().min(1),
});
export const MainHostSetRequestSchema = MainHostSetInputSchema.extend({
  type: z.literal("fleet.main_host.set.request"),
});
export const MainHostApplyRequestSchema = MainHostApplyInputSchema.extend({
  type: z.literal("fleet.main_host.apply.request"),
});

const MainHostResponsePayloadSchema = z.object({
  requestId: z.string(),
  state: MainHostStateSchema,
  allocator: z.object({ serverId: z.string(), publicKey: z.string() }),
});
export const MainHostGetResponseSchema = z.object({
  type: z.literal("fleet.main_host.get.response"),
  payload: MainHostResponsePayloadSchema,
});
export const MainHostSetResponseSchema = z.object({
  type: z.literal("fleet.main_host.set.response"),
  payload: MainHostResponsePayloadSchema,
});
export const MainHostApplyResponseSchema = z.object({
  type: z.literal("fleet.main_host.apply.response"),
  payload: MainHostResponsePayloadSchema,
});

export type MainHostProvenance = z.infer<typeof MainHostProvenanceSchema>;
export type MainHostAllocation = z.infer<typeof MainHostAllocationSchema>;
export type MainHostChoice = z.infer<typeof MainHostChoiceSchema>;
export type MainHostDelivery = z.infer<typeof MainHostDeliverySchema>;
export type MainHostState = z.infer<typeof MainHostStateSchema>;
export type MainHostSetInput = z.infer<typeof MainHostSetInputSchema>;
export type MainHostApplyInput = z.infer<typeof MainHostApplyInputSchema>;

/** Fixed field order is part of receipt format v1; held/confirmation are receiver-local. */
export function serializeMainHostAllocation(choice: MainHostAllocation): string {
  return JSON.stringify([
    "paseo.main-host.v1",
    choice.allocationId,
    choice.allocatorServerId,
    choice.requestId,
    choice.mainHost,
    choice.generation,
    choice.previousMainHost,
    choice.undoOf,
    choice.setAt,
    choice.setBy.principalId,
    choice.setBy.clientId,
    choice.setBy.sessionId,
    choice.setBy.serverId,
    choice.setBy.clientType,
  ]);
}
