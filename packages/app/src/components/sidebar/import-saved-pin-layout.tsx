import { useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { splitPinnedSidebarGroups, usePinnedSidebarKeys } from "@/hooks/use-sidebar-pins";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarModel } from "./sidebar-model";
import { seedPinnedWorkspaceTree } from "./workspace-tree/pinned-layout";
import {
  acceptSharedPinPlacement,
  changedPinPlacements,
  saveSharedPinPlacements,
} from "./workspace-tree/shared-pin-placement";

/** COMPAT(local-pin-layout): added in v0.13.0-beta.1, remove after 2027-04-22.
 * Only an explicit import can publish a legacy client layout. A stale client must
 * never overwrite placements already shared by another client.
 */
export function ImportSavedPinLayout() {
  const { allProjects } = useSidebarModel();
  const keys = usePinnedSidebarKeys(allProjects);
  const legacyTree = useSidebarOrderStore((state) => state.pinnedWorkspaceTree);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const superpinnedWorkspaceOrder = useSidebarOrderStore(
    (state) => state.superpinnedWorkspaceOrder,
  );
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const updates = useMemo(() => {
    if (Object.keys(legacyTree).length === 0) return [];
    const groups = splitPinnedSidebarGroups({
      projects: allProjects,
      keys,
      pinnedWorkspaceOrder,
      superpinnedWorkspaceOrder,
      pinnedWorkspaceTree: legacyTree,
    });
    const workspaces = [...groups.superpinnedChats, ...groups.pinnedChats].filter(
      (workspace) => !workspace.pinPlacement,
    );
    const tree = seedPinnedWorkspaceTree(legacyTree, [
      ...groups.superpinnedChats,
      ...groups.pinnedChats,
    ]);
    return changedPinPlacements({ previous: {}, next: tree, workspaces });
  }, [allProjects, keys, legacyTree, pinnedWorkspaceOrder, superpinnedWorkspaceOrder]);
  const importLayout = useCallback(async () => {
    setPending(true);
    try {
      await saveSharedPinPlacements({
        updates,
        sourceWorkspaceKey: "",
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
        accepted: acceptSharedPinPlacement,
      });
      toast.show("Pin layout now syncs across clients.", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to share saved pin layout.");
    } finally {
      setPending(false);
    }
  }, [updates, toast]);
  if (!updates.length) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending}
      loading={pending}
      onPress={importLayout}
      testID="sidebar-share-saved-pin-layout"
    >
      Share saved layout
    </Button>
  );
}
