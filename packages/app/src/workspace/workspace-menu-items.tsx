import {
  useCallback,
  useMemo,
  type ComponentProps,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  Archive,
  Circle,
  CircleCheck,
  Copy,
  CornerDownRight,
  Pencil,
  Pin,
  PinOff,
  Tag,
} from "lucide-react-native";
import { router } from "expo-router";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { DropdownMenuItem, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { WORKSPACE_LABEL_PAGE_ID } from "@/workspace-labels/picker";

import {
  useSidebarWorkspaceSuperpinController,
  useWorkspacePinPending,
} from "@/hooks/use-sidebar-workspace-pin";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { generateDraftId } from "@/stores/draft-keys";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedCircle = withUnistyles(Circle);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedTag = withUnistyles(Tag);
const ThemedChild = withUnistyles(CornerDownRight);

const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const markAsReadLeadingIcon = (
  <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
);
const markAsUnreadLeadingIcon = <ThemedCircle size={14} uniProps={foregroundMutedColorMapping} />;
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const pinLeadingIcon = <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />;
const unpinLeadingIcon = <ThemedPinOff size={14} uniProps={foregroundMutedColorMapping} />;
const childLeadingIcon = <ThemedChild size={14} uniProps={foregroundMutedColorMapping} />;

export interface WorkspaceMenuItemsProps {
  workspaceKey: string;
  testIDPrefix?: string;
  serverId?: string;
  workspaceId?: string;
  workspaceLabels?: readonly string[];
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  openInFileManagerPath?: string | null;
}

type MenuSurface = "context" | "dropdown";

function WorkspaceMenuItem({
  surface,
  children,
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { surface: MenuSurface }
>) {
  if (surface === "context") {
    return <ContextMenuItem {...props}>{children}</ContextMenuItem>;
  }
  return <DropdownMenuItem {...props}>{children}</DropdownMenuItem>;
}

export function WorkspaceMenuItems({
  surface,
  workspaceKey,
  testIDPrefix = `sidebar-workspace-menu`,
  serverId,
  workspaceId,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
}: WorkspaceMenuItemsProps & { surface: MenuSurface }): ReactNode {
  const { t } = useTranslation();
  const pinPending = useWorkspacePinPending(workspaceKey);
  const archiveTrailing = useMemo(
    () => (archiveShortcutKeys ? <Shortcut chord={archiveShortcutKeys} /> : null),
    [archiveShortcutKeys],
  );
  const labelLeading = useMemo(
    () => <ThemedTag size={14} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  return (
    <>
      {onCopyPath ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-copy-path-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyPath}
        >
          {t("sidebar.workspace.actions.copyPath")}
        </WorkspaceMenuItem>
      ) : null}
      {onCopyBranchName ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-copy-branch-name-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyBranchName}
        >
          {t("sidebar.workspace.actions.copyBranchName")}
        </WorkspaceMenuItem>
      ) : null}
      {onRename ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-rename-${workspaceKey}`}
          leading={renameLeadingIcon}
          onSelect={onRename}
        >
          {t("sidebar.workspace.actions.rename")}
        </WorkspaceMenuItem>
      ) : null}
      {serverId && workspaceId ? (
        <WorkspaceAddChildMenuItem
          surface={surface}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceKey={workspaceKey}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
      {onMarkAsRead ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-mark-as-read-${workspaceKey}`}
          leading={markAsReadLeadingIcon}
          onSelect={onMarkAsRead}
        >
          Mark as read
        </WorkspaceMenuItem>
      ) : null}
      {onMarkAsUnread ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-mark-as-unread-${workspaceKey}`}
          leading={markAsUnreadLeadingIcon}
          onSelect={onMarkAsUnread}
        >
          Mark as unread
        </WorkspaceMenuItem>
      ) : null}
      {onTogglePin ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-pin-${workspaceKey}`}
          leading={isPinned ? unpinLeadingIcon : pinLeadingIcon}
          onSelect={onTogglePin}
          disabled={pinPending}
          status={pinPending ? "pending" : "idle"}
        >
          {isPinned ? t("sidebar.workspace.actions.unpin") : t("sidebar.workspace.actions.pin")}
        </WorkspaceMenuItem>
      ) : null}
      {serverId && workspaceId ? (
        <WorkspaceSuperpinMenuItem
          surface={surface}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceKey={workspaceKey}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
      {serverId && workspaceId ? (
        <DropdownMenuSubTrigger
          id={WORKSPACE_LABEL_PAGE_ID}
          leading={labelLeading}
          testID={`${testIDPrefix}-labels-${workspaceKey}`}
        >
          {t("workspaceLabels.title")}
        </DropdownMenuSubTrigger>
      ) : null}
      <OpenInFileManagerMenuItem
        surface={surface}
        path={openInFileManagerPath}
        testID={`${testIDPrefix}-open-folder-${workspaceKey}`}
      />
      {onArchive ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`${testIDPrefix}-archive-${workspaceKey}`}
          leading={archiveLeadingIcon}
          trailing={archiveTrailing}
          status={archiveStatus}
          pendingLabel={archivePendingLabel}
          onSelect={onArchive}
        >
          {archiveLabel ?? t("sidebar.workspace.actions.archive")}
        </WorkspaceMenuItem>
      ) : null}
    </>
  );
}

function WorkspaceAddChildMenuItem({
  surface,
  serverId,
  workspaceId,
  workspaceKey,
  testIDPrefix,
}: {
  surface: MenuSurface;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const workspace = useWorkspaceFields(serverId, workspaceId, (value) => ({
    projectId: value.projectId,
    projectRootPath: value.projectRootPath,
    projectDisplayName: value.projectDisplayName,
    background: value.background,
    archivingAt: value.archivingAt,
  }));
  const addChild = useCallback(() => {
    if (!workspace) return;
    router.push(
      buildNewWorkspaceRoute({
        serverId,
        sourceDirectory: workspace.projectRootPath,
        projectId: workspace.projectId,
        displayName: workspace.projectDisplayName,
        parentWorkspaceKey: workspaceKey,
        draftId: generateDraftId(),
      }),
    );
  }, [serverId, workspace, workspaceKey]);
  if (!workspace || workspace.background || workspace.archivingAt) return null;
  return (
    <WorkspaceMenuItem
      surface={surface}
      leading={childLeadingIcon}
      testID={`${testIDPrefix}-add-child-${workspaceKey}`}
      onSelect={addChild}
    >
      {t("sidebar.workspace.actions.addChild")}
    </WorkspaceMenuItem>
  );
}

function WorkspaceSuperpinMenuItem({
  surface,
  serverId,
  workspaceId,
  workspaceKey,
  testIDPrefix,
}: {
  surface: MenuSurface;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const canSuperpin = useHostFeatureAvailability(serverId, "workspaceSuperpinning");
  const connected = useHostRuntimeIsConnected(serverId);
  const pending = useWorkspacePinPending(workspaceKey);
  const fields = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    id: workspace.id,
    pinnedAt: workspace.pinnedAt ?? null,
    superpinnedAt: workspace.superpinnedAt ?? null,
  }));
  const toggle = useSidebarWorkspaceSuperpinController();
  const onSelect = useCallback(() => {
    if (fields)
      toggle({
        serverId,
        workspaceId: fields.id,
        workspaceKey,
        pinnedAt: fields.pinnedAt,
        superpinnedAt: fields.superpinnedAt,
      });
  }, [fields, serverId, workspaceKey, toggle]);
  if (canSuperpin !== true || !fields) return null;
  return (
    <WorkspaceMenuItem
      surface={surface}
      testID={`${testIDPrefix}-superpin-${workspaceKey}`}
      leading={pinLeadingIcon}
      disabled={!connected || canSuperpin !== true || pending}
      status={pending ? "pending" : "idle"}
      onSelect={onSelect}
    >
      {fields.superpinnedAt ? t("sidebar.superpinned.remove") : t("sidebar.superpinned.action")}
    </WorkspaceMenuItem>
  );
}
