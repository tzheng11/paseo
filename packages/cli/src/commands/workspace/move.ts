import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRow } from "./shared.js";

export interface WorkspaceMoveOptions extends CommandOptions {
  parent?: string;
  root?: boolean;
  before?: string;
}

export function resolveWorkspaceMove(
  options: Pick<WorkspaceMoveOptions, "parent" | "root" | "before">,
) {
  const parent = options.parent?.trim();
  if (options.root && options.parent !== undefined) {
    throw {
      code: "INVALID_OPTIONS",
      message: "Use --parent or --root, not both",
    } satisfies CommandError;
  }
  if (options.before !== undefined && !options.before.trim()) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--before requires a workspace id",
    } satisfies CommandError;
  }
  const beforeWorkspaceId = options.before?.trim();
  if (options.root) return { parentWorkspaceId: null, beforeWorkspaceId };
  if (!parent) {
    throw {
      code: "INVALID_OPTIONS",
      message: "Choose a destination with --parent <workspace-id> or --root",
    } satisfies CommandError;
  }
  return { parentWorkspaceId: parent, beforeWorkspaceId };
}

export async function runMoveCommand(
  workspaceId: string,
  options: WorkspaceMoveOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRow>> {
  const move = resolveWorkspaceMove(options);
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const applied = await client.moveWorkspace({ workspaceId, ...move });
    const workspace = applied.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("The daemon did not return the moved workspace");
    return { type: "single", data: toWorkspaceRow(workspace), schema: workspaceSchema };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_MOVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
