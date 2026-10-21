import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export interface WorkspaceRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
  cwd: string;
  background: boolean;
  pinnedAt?: string | null;
  superpinnedAt?: string | null;
  parentWorkspaceId: string | null;
  siblingOrder: number;
}

export const workspaceSchema: OutputSchema<WorkspaceRow> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "CWD", field: "cwd", width: 42 },
  ],
};

/** `--background` listings add a column so hidden workspaces stand out. */
export const workspaceWithBackgroundSchema: OutputSchema<WorkspaceRow> = {
  ...workspaceSchema,
  columns: [
    ...workspaceSchema.columns,
    { header: "BACKGROUND", field: (row) => (row.background ? "yes" : ""), width: 8 },
  ],
};

export function toWorkspaceRow(workspace: WorkspaceDescriptorPayload): WorkspaceRow {
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    cwd: workspace.workspaceDirectory,
    background: workspace.background === true,
    pinnedAt: workspace.pinnedAt,
    superpinnedAt: workspace.superpinnedAt,
    // COMPAT(workspaceHierarchy): added in v0.11.2, remove after 2027-04-21 once daemon floor >= v0.11.2.
    parentWorkspaceId: workspace.parentWorkspaceId ?? null,
    siblingOrder: workspace.siblingOrder ?? 0,
  };
}
