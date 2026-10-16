import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { resolveSidebarWorkspacePrimaryLabel } from "./sidebar-workspace-title";

export type SidebarWorkspaceSortMode = "manual" | "alphabetical" | "activity";

interface SidebarWorkspaceSortInput<T extends SidebarWorkspacePlacement> {
  workspaces: readonly T[];
  mode: SidebarWorkspaceSortMode;
  workspaceTitleSource: WorkspaceTitleSource;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
}

function activityTime(entry: SidebarWorkspaceEntry | undefined): number | null {
  const time = entry?.statusEnteredAt?.getTime();
  return time !== undefined && Number.isFinite(time) ? time : null;
}

export function sortSidebarWorkspaces<T extends SidebarWorkspacePlacement>(
  input: SidebarWorkspaceSortInput<T>,
): T[] {
  const sorted = [...input.workspaces];
  if (input.mode === "manual") return sorted;

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const label = (workspace: T) => {
    const entry = input.workspaceEntriesByKey.get(workspace.workspaceKey);
    return entry
      ? resolveSidebarWorkspacePrimaryLabel({
          workspace: entry,
          workspaceTitleSource: input.workspaceTitleSource,
        })
      : workspace.name;
  };

  sorted.sort((left, right) => {
    if (input.mode === "alphabetical") {
      return (
        collator.compare(label(left), label(right)) ||
        left.workspaceKey.localeCompare(right.workspaceKey)
      );
    }

    const leftTime = activityTime(input.workspaceEntriesByKey.get(left.workspaceKey));
    const rightTime = activityTime(input.workspaceEntriesByKey.get(right.workspaceKey));
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return rightTime - leftTime;
    }
    return left.workspaceKey.localeCompare(right.workspaceKey);
  });
  return sorted;
}
