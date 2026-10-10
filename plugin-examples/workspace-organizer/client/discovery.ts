import type { getPaseoClient } from "@getpaseo/plugin/client";

type Api = ReturnType<typeof getPaseoClient>;
type WorkspaceListResult = Awaited<ReturnType<Api["workspaces"]["list"]>>;
type WorkspaceListOptions = Parameters<Api["workspaces"]["list"]>[0];
export type Workspace = WorkspaceListResult["entries"][number];
export type WorkspaceList = (options?: WorkspaceListOptions) => Promise<WorkspaceListResult>;

export async function listAllWorkspaces(
  list: WorkspaceList,
  signal: AbortSignal,
): Promise<Workspace[]> {
  const entries = new Map<string, Workspace>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (signal.aborted) throw new Error("Workspace discovery cancelled");
    const page = await list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const workspace of page.entries) entries.set(workspace.id, workspace);
    if (!page.pageInfo.hasMore) return [...entries.values()];
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next))
      throw new Error("The host returned an invalid workspace cursor");
    cursors.add(next);
    cursor = next;
  } while (cursor);
  return [...entries.values()];
}
