import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface WorkspaceMoveResult {
  workspaceId: string;
  parentWorkspaceId: string | null;
  siblingOrder: number;
}

interface WorkspaceMoveDestination {
  parentWorkspaceId: string | null;
  beforeWorkspaceId?: string;
}

export interface WorkspaceMoveOptions extends CommandOptions {
  parent?: string;
  root?: boolean;
  before?: string;
}

const workspaceMoveSchema: OutputSchema<WorkspaceMoveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PARENT", field: "parentWorkspaceId", width: 20 },
    { header: "ORDER", field: "siblingOrder", width: 10 },
  ],
};

export function resolveWorkspaceMoveDestination(
  options: Pick<WorkspaceMoveOptions, "parent" | "root" | "before">,
): WorkspaceMoveDestination {
  const parentWorkspaceId = options.parent?.trim();
  const hasParent = options.parent !== undefined;
  if (hasParent === Boolean(options.root)) {
    throw {
      code: "INVALID_OPTIONS",
      message: "Specify exactly one of --parent <id> or --root",
    } satisfies CommandError;
  }
  if (hasParent && !parentWorkspaceId) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--parent must be a workspace id",
    } satisfies CommandError;
  }
  const beforeWorkspaceId = options.before?.trim();
  if (options.before !== undefined && !beforeWorkspaceId) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--before must be a workspace id",
    } satisfies CommandError;
  }
  return {
    parentWorkspaceId: parentWorkspaceId ?? null,
    ...(beforeWorkspaceId !== undefined ? { beforeWorkspaceId } : {}),
  };
}

export async function runMoveCommand(
  workspaceId: string,
  options: WorkspaceMoveOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceMoveResult>> {
  const destination = resolveWorkspaceMoveDestination(options);
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const applied = await client.moveWorkspace(workspaceId, destination);
    return {
      type: "single",
      data: { workspaceId, ...applied },
      schema: workspaceMoveSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_MOVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
