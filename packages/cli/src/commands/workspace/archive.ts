import { WorkspaceRetirementBindingSchema } from "@getpaseo/protocol/workspace-layout";
import type {
  WorkspaceRetirementOperation,
  WorkspaceRetirementResult,
  WorkspaceRetirementBinding,
} from "@getpaseo/protocol/workspace-layout";
import type { ArchiveWorkspaceResponseMessage } from "@getpaseo/protocol/messages";
import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceArchiveResult {
  retirement?: ArchiveWorkspaceResponseMessage["payload"]["retirement"];
  removedDirectory?: boolean;
  slotKept?: boolean;
  directoryLeftBehind?: { path: string; reason: string };
  workspaceId: string;
  status: "archived";
  archivedAt: string;
}

const workspaceArchiveSchema: OutputSchema<WorkspaceArchiveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ARCHIVED AT", field: "archivedAt", width: 26 },
  ],
};

export async function runArchiveCommand(
  workspaceId: string,
  options: {
    host?: string;
    operationId?: string;
    daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  },
  _command: Command,
): Promise<SingleResult<WorkspaceArchiveResult>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const payload = await (options.operationId
      ? client.archiveWorkspace(workspaceId, { operationId: options.operationId })
      : client.archiveWorkspace(workspaceId));
    if (payload.error) {
      throw {
        code:
          payload.retirement?.state === "partial"
            ? "WORKSPACE_RETIREMENT_PARTIAL"
            : "WORKSPACE_ARCHIVE_FAILED",
        message: payload.error,
        details: payload,
      } satisfies CommandError;
    }
    if (!payload.archivedAt) {
      throw new Error("Workspace archive did not return an archive timestamp");
    }
    return {
      type: "single",
      data: {
        workspaceId,
        status: "archived",
        archivedAt: payload.archivedAt,
        ...(payload.retirement
          ? {
              retirement: payload.retirement,
              removedDirectory: payload.removedDirectory,
              slotKept: payload.slotKept,
              directoryLeftBehind: payload.directoryLeftBehind,
            }
          : {}),
      },
      schema: workspaceArchiveSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (!options.operationId) throw error;
      throw {
        code: typeof error.code === "string" ? error.code : "WORKSPACE_ARCHIVE_FAILED",
        message: archiveRequestErrorMessage(error),
        details: {
          ...("details" in error && error.details && typeof error.details === "object"
            ? error.details
            : {}),
          operationId: options.operationId,
          workspaceId,
        },
      } satisfies CommandError;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_ARCHIVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function archiveRequestErrorMessage(error: object): string {
  if (error instanceof Error) return error.message;
  if ("message" in error) return String(error.message);
  return "Workspace archive request did not return a result";
}
interface RetirementReadOptions {
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
}
interface RetirementStatusResult {
  operationId: string;
  state: WorkspaceRetirementOperation["state"] | "not-found";
  operation: WorkspaceRetirementOperation | null;
}
export async function runRetirementStatusCommand(
  operationId: string,
  options: RetirementReadOptions,
  _command: Command,
): Promise<SingleResult<RetirementStatusResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const operation = await client.getWorkspaceRetirementStatus(operationId);
    return {
      type: "single",
      data: { operationId, state: operation?.state ?? "not-found", operation },
      schema: {
        idField: "operationId",
        columns: [
          { header: "OPERATION ID", field: "operationId", width: 36 },
          { header: "STATE", field: "state", width: 12 },
        ],
      },
    };
  } finally {
    await client.close();
  }
}
export async function runRetirementVerifyCommand(
  operationId: string,
  options: RetirementReadOptions & Partial<Omit<WorkspaceRetirementBinding, "operationId">>,
  _command: Command,
): Promise<SingleResult<{ operationId: string; valid: boolean }>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { workspaceId, backingGeneration, worktreePath, teardownCwd } = options;
    const binding = WorkspaceRetirementBindingSchema.parse({
      operationId,
      workspaceId,
      backingGeneration,
      worktreePath,
      teardownCwd,
    });
    const result = await client.verifyWorkspaceRetirementBinding(binding);
    if (!result.valid)
      throw {
        code: "WORKSPACE_RETIREMENT_BINDING_INVALID",
        message: result.code ?? "Retirement hook is not active",
        details: { operationId },
      } satisfies CommandError;
    return {
      type: "single",
      data: { operationId, valid: true },
      schema: {
        idField: "operationId",
        columns: [
          { header: "OPERATION ID", field: "operationId", width: 36 },
          { header: "VALID", field: "valid", width: 6 },
        ],
      },
    };
  } finally {
    await client.close();
  }
}

interface RetirementRecoverResult extends WorkspaceRetirementResult {
  operationId: string;
  state: "complete" | "partial";
}
export async function runRetirementRecoverCommand(
  operationId: string,
  options: RetirementReadOptions & { effectsClosed?: boolean; backingGeneration?: string },
  _command: Command,
): Promise<SingleResult<RetirementRecoverResult>> {
  if (options.effectsClosed && !options.backingGeneration)
    throw {
      code: "RETIREMENT_RECOVERY_CONFIRMATION_BINDING_REQUIRED",
      message: "--effects-closed requires --backing-generation from retirement-status.",
    } satisfies CommandError;
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const confirmation =
      options.effectsClosed || options.backingGeneration
        ? {
            effectsClosed: options.effectsClosed,
            expectedBackingGeneration: options.backingGeneration,
          }
        : undefined;
    const result = confirmation
      ? await client.recoverWorkspaceRetirement(operationId, confirmation)
      : await client.recoverWorkspaceRetirement(operationId);
    if (!result.retirement) throw new Error("Retirement recovery returned no operation outcome");
    return {
      type: "single" as const,
      data: { operationId, state: result.retirement.state, ...result },
      schema: {
        idField: "operationId",
        columns: [
          { header: "OPERATION ID", field: "operationId", width: 36 },
          { header: "STATE", field: "state", width: 12 },
        ],
      },
    };
  } finally {
    await client.close();
  }
}
