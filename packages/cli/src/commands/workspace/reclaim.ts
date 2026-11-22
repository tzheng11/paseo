import type { SingleResult } from "../../output/types.js";
import type { WorkspaceBackingReclaimOperation } from "@getpaseo/protocol/workspace-backing-reclaim";
import type { Command } from "commander";
import {
  WorkspaceBackingReclaimInputSchema,
  WorkspaceBackingReclaimBindingSchema,
  WorkspaceBackingReclaimApplyRequestSchema,
} from "@getpaseo/protocol/workspace-backing-reclaim";
import { z } from "zod";
import { connectToDaemon } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
interface ReclaimOptions {
  daemonTarget: DaemonTarget;
  releaseEvidence?: string;
  workspaceId?: string;
  originalOperationId?: string;
  originalBackingGeneration?: string;
  apply?: boolean;
  operationId?: string;
  expectedGeneration?: string;
}
export async function runReclaimCommand(
  targetPath: string,
  options: ReclaimOptions,
  _command: Command,
): Promise<SingleResult<{ result: unknown }>> {
  const target = options.workspaceId
    ? {
        kind: "retired",
        path: targetPath,
        workspaceId: options.workspaceId,
        retirementOperationId: options.originalOperationId,
        backingGeneration: options.originalBackingGeneration,
      }
    : { kind: "orphan", path: targetPath };
  const input = WorkspaceBackingReclaimInputSchema.parse({
    target,
    releaseEvidence: options.releaseEvidence,
  });
  const apply = options.apply
    ? WorkspaceBackingReclaimApplyRequestSchema.omit({ type: true, requestId: true }).parse({
        ...input,
        operationId: options.operationId,
        expectedGeneration: options.expectedGeneration,
      })
    : null;
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const result = apply
      ? await client.reclaimWorkspaceBacking(apply)
      : await client.previewWorkspaceBackingReclaim(input);
    return {
      type: "single" as const,
      data: { result },
      schema: {
        idField: () => options.operationId ?? "preview",
        columns: [{ header: "RESULT", field: "result", width: 36 }],
      },
    };
  } catch (error) {
    if (apply && error && typeof error === "object")
      Object.assign(error, { details: { operationId: apply.operationId } });
    throw error;
  } finally {
    await client.close();
  }
}
export async function runReclaimStatusCommand(
  operationId: string,
  options: Pick<ReclaimOptions, "daemonTarget">,
  _command: Command,
): Promise<
  SingleResult<{
    operationId: string;
    state: string;
    operation: WorkspaceBackingReclaimOperation | null;
  }>
> {
  operationId = z.string().uuid().parse(operationId);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const operation = await client.getWorkspaceBackingReclaimStatus(operationId);
    return {
      type: "single" as const,
      data: { operationId, state: operation?.state ?? "not-found", operation },
      schema: { idField: "operationId", columns: [{ header: "STATE", field: "state", width: 14 }] },
    };
  } finally {
    await client.close();
  }
}
export async function runReclaimVerifyCommand(
  operationId: string,
  options: Pick<ReclaimOptions, "daemonTarget"> & {
    expectedGeneration?: string;
    path?: string;
    releaseEvidence?: string;
    ownerReleased?: boolean;
    externalReferencesClear?: boolean;
  },
  _command: Command,
): Promise<SingleResult<{ operationId: string; valid: boolean; code: string | null }>> {
  const binding = WorkspaceBackingReclaimBindingSchema.parse({
    operationId,
    generation: options.expectedGeneration,
    path: options.path,
    releaseEvidence: options.releaseEvidence,
    ownerReleased: options.ownerReleased,
    externalReferencesClear: options.externalReferencesClear,
  });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const result = await client.verifyWorkspaceBackingReclaim(binding);
    if (!result.valid)
      throw Object.assign(new Error(result.code ?? "Reclaim refused"), {
        code: result.code ?? "reclaim_hook_not_active",
      });
    return {
      type: "single" as const,
      data: { operationId, ...result },
      schema: { idField: "operationId", columns: [{ header: "VALID", field: "valid", width: 8 }] },
    };
  } finally {
    await client.close();
  }
}
