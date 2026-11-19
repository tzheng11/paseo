import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  workspaceParentRevealKeys,
  type WorkspaceParentEntry,
  type WorkspaceSidebarSection,
} from "./parent-selection";

export function revealCreatedChildWorkspace(input: {
  placement: { parentWorkspaceKey: string; section: WorkspaceSidebarSection } | undefined;
  workspaces: readonly WorkspaceParentEntry[];
}): void {
  if (!input.placement) return;
  const keys = workspaceParentRevealKeys({ ...input.placement, workspaces: input.workspaces });
  const section = input.placement.section;
  useSidebarCollapsedSectionsStore.setState((state) => ({
    collapsedWorkspaceKeys: new Set(
      [...state.collapsedWorkspaceKeys].filter((key) => !keys.has(key)),
    ),
    collapsedWorkspaceGroupKeys: new Set(
      [...state.collapsedWorkspaceGroupKeys].filter(
        (key) => section !== "superpinned" || key !== "section:superpinned",
      ),
    ),
    collapsedPinned: section === "pinned" ? false : state.collapsedPinned,
  }));
}
