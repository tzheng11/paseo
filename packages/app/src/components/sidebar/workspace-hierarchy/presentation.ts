import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { WorkspaceTreeRow } from "./tree";

/** A collapsed parent carries the most urgent state of the descendants it hides. */
export function collapsedWorkspaceTreeEntries(input: {
  rows: readonly WorkspaceTreeRow[];
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsedKeys: ReadonlySet<string>;
}): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const aggregate = new Map<string, SidebarStateBucket>();
  for (const [key, entry] of input.entries) aggregate.set(key, entry.statusBucket);
  for (const row of input.rows.toReversed()) {
    if (!row.parentKey) continue;
    const child = aggregate.get(row.workspace.workspaceKey) ?? "done";
    const parent = aggregate.get(row.parentKey) ?? "done";
    aggregate.set(row.parentKey, aggregateSidebarStateBuckets([child, parent]));
  }
  const entries = new Map(input.entries);
  for (const key of input.collapsedKeys) {
    const entry = input.entries.get(key);
    const statusBucket = aggregate.get(key);
    if (entry && statusBucket && statusBucket !== entry.statusBucket)
      entries.set(key, { ...entry, statusBucket });
  }
  return entries;
}
