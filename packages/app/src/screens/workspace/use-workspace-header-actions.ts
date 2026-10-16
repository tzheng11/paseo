import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useHostFeature } from "@/runtime/host-features";
import { useSidebarWorkspacePinController } from "@/hooks/use-sidebar-workspace-pin";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceLabelMenuPages, type WorkspaceLabelTarget } from "@/workspace-labels/picker";
import type { WorkspaceMenuItemsProps } from "@/workspace/workspace-menu-items";

/** The header uses the same mutation controllers and canonical identity as sidebar rows. */
export function useWorkspaceHeaderActions(serverId: string, routeWorkspaceId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const workspace = useWorkspace(serverId, routeWorkspaceId);
  const workspaceId = workspace?.id ?? routeWorkspaceId;
  const workspaceKey = `${serverId}:${workspaceId}`;
  const [renameOpen, setRenameOpen] = useState(false);
  const openRename = useCallback(() => setRenameOpen(true), []);
  const closeRename = useCallback(() => setRenameOpen(false), []);
  const canPin = useHostFeature(serverId, "workspacePinning");
  const togglePin = useSidebarWorkspacePinController();
  const onTogglePin = useCallback(() => {
    if (workspace) togglePin({ serverId, workspaceId, workspaceKey, pinnedAt: workspace.pinnedAt });
  }, [serverId, togglePin, workspace, workspaceId, workspaceKey]);
  const { onArchive, isArchiving } = useHeaderWorkspaceArchive(
    serverId,
    routeWorkspaceId,
    workspace,
  );
  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, canMarkUnread, clearAttention, markUnread } =
    useWorkspaceReadState({ serverId, workspaceId });
  const onMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) =>
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read"),
    );
  }, [clearAttention, toast]);
  const onMarkAsUnread = useCallback(() => {
    void markUnread().catch((error) =>
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as unread"),
    );
  }, [markUnread, toast]);
  const target = useMemo<WorkspaceLabelTarget | null>(
    () => (workspace ? { serverId, workspaceId, labels: workspace.labels ?? [] } : null),
    [serverId, workspace, workspaceId],
  );
  const pages = useWorkspaceLabelMenuPages(target);
  const menuItems: WorkspaceMenuItemsProps = {
    workspaceKey,
    testIDPrefix: "workspace-header",
    serverId: workspace ? serverId : undefined,
    workspaceId: workspace?.id,
    onRename: workspace ? openRename : undefined,
    onTogglePin: workspace && canPin ? onTogglePin : undefined,
    isPinned: workspace?.pinnedAt != null,
    onMarkAsRead: hasClearableAttention ? onMarkAsRead : undefined,
    onMarkAsUnread: canMarkUnread ? onMarkAsUnread : undefined,
    onArchive: workspace ? onArchive : undefined,
    archiveStatus: isArchiving ? "pending" : "idle",
    archivePendingLabel: t("sidebar.workspace.actions.archiving"),
    archiveShortcutKeys,
    openInFileManagerPath: workspace?.workspaceDirectory || workspace?.projectRootPath,
  };
  const renameTarget = workspace
    ? { serverId, workspaceId, name: workspace.name, title: workspace.title ?? null }
    : null;
  return { menuItems, pages, renameTarget, renameOpen, closeRename };
}

function useHeaderWorkspaceArchive(
  serverId: string,
  routeWorkspaceId: string,
  workspace: WorkspaceDescriptor | null,
) {
  const workspaceId = workspace?.id ?? routeWorkspaceId;
  const [isHiding, setIsHiding] = useState(false);
  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId,
      workspaceId,
      activeWorkspaceSelection: { serverId, workspaceId },
    });
  }, [serverId, workspaceId]);
  const archive = useWorkspaceArchive({
    serverId,
    workspaceId,
    workspaceKind: workspace?.workspaceKind ?? "directory",
    name: workspace?.name ?? "",
    isDirty: workspace?.gitRuntime?.isDirty,
    aheadOfOrigin: workspace?.gitRuntime?.aheadOfOrigin,
    diffStat: workspace?.diffStat,
    onArchiveStarted: redirectAfterArchive,
    onSetHiding: setIsHiding,
  });
  const isArchiving = isHiding || workspace?.archivingAt != null;
  const onArchive = useCallback(() => {
    if (workspace && !isArchiving) archive.archive();
  }, [archive, isArchiving, workspace]);
  return { onArchive, isArchiving };
}
