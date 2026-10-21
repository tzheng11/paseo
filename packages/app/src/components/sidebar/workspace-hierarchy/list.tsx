import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DensityIcon } from "@/components/ui/density-icon";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { WorkspaceTreeDrag } from "./drag";
import { useWorkspaceTreeStore } from "./state";
import {
  buildWorkspaceTree,
  WORKSPACE_TREE_INDENT,
  type WorkspaceTreeMove,
  type WorkspaceTreeRow,
} from "./tree";
import type { WorkspaceTreeRenderInput } from "./drag.types";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { WorkspaceTreeRowContext } from "./row-context";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
function spinnerColor(theme: Theme) {
  return { color: theme.colors.foregroundMuted };
}

interface WorkspaceHierarchyListProps {
  project: SidebarProjectEntry;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  hierarchySupportByServerId: ReadonlyMap<string, boolean>;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  renderWorkspace: (
    workspace: SidebarWorkspacePlacement,
    input: {
      drag: () => void;
      isDragging: boolean;
      dragHandleProps?: DraggableListDragHandleProps;
    },
  ) => ReactElement;
}

function WorkspaceHierarchyRow({
  input,
  collapsed,
  toggle,
  renderWorkspace,
}: {
  input: WorkspaceTreeRenderInput;
  collapsed: boolean;
  toggle: (key: string) => void;
  renderWorkspace: WorkspaceHierarchyListProps["renderWorkspace"];
}) {
  const { row } = input;
  const key = row.workspace.workspaceKey;
  const onToggle = useCallback(() => toggle(key), [toggle, key]);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const style = useMemo(
    () => [styles.row, { paddingLeft: row.depth * WORKSPACE_TREE_INDENT }],
    [row.depth],
  );
  return (
    <View style={style}>
      <View style={styles.disclosure}>
        {row.hasChildren ? (
          <ToolbarButton
            label={collapsed ? "Expand child workspaces" : "Collapse child workspaces"}
            onPress={onToggle}
            accessibilityState={accessibilityState}
            testID={`sidebar-workspace-toggle-${key}`}
            compact
          >
            <DensityIcon
              icon={collapsed ? ChevronRight : ChevronDown}
              size="xs"
              color="foregroundMuted"
            />
          </ToolbarButton>
        ) : null}
      </View>
      <View style={styles.content}>
        <WorkspaceTreeRowContext.Provider value>
          {renderWorkspace(row.workspace, input)}
        </WorkspaceTreeRowContext.Provider>
      </View>
    </View>
  );
}

export function WorkspaceHierarchyList({
  project,
  workspaceEntriesByKey,
  hierarchySupportByServerId,
  activeWorkspaceSelection,
  renderWorkspace,
}: WorkspaceHierarchyListProps) {
  const collapsed = useWorkspaceTreeStore((state) => state.collapsedKeys);
  const toggle = useWorkspaceTreeStore((state) => state.toggle);
  const expand = useWorkspaceTreeStore((state) => state.expand);
  const collapsedKeys = useMemo(() => new Set(collapsed), [collapsed]);
  const sortMode = useSidebarOrderStore(
    (state) => state.workspaceSortModeByProject[project.viewKey] ?? "manual",
  );
  const setSortMode = useSidebarOrderStore((state) => state.setWorkspaceSortMode);
  const rows = useMemo(
    () =>
      buildWorkspaceTree(
        project.workspaces.map((workspace) => {
          const entry = workspaceEntriesByKey.get(workspace.workspaceKey);
          return {
            ...workspace,
            parentWorkspaceId: entry?.parentWorkspaceId ?? null,
            siblingOrder: entry?.siblingOrder,
          };
        }),
        sortMode !== "manual",
      ),
    [project.workspaces, workspaceEntriesByKey, sortMode],
  );
  const activeKey = activeWorkspaceSelection
    ? `${activeWorkspaceSelection.serverId}:${activeWorkspaceSelection.workspaceId}`
    : null;
  const activeAncestorPath = useMemo(() => {
    if (!activeKey) return "";
    const byKey = new Map(rows.map((row) => [row.workspace.workspaceKey, row]));
    const ancestors: string[] = [];
    let parent = byKey.get(activeKey)?.parentKey ?? null;
    while (parent) {
      ancestors.push(parent);
      parent = byKey.get(parent)?.parentKey ?? null;
    }
    return ancestors.join("\u0000");
  }, [activeKey, rows]);
  // Direct links, notifications and Command Center can select a hidden descendant.
  useEffect(() => {
    if (activeAncestorPath) expand(activeAncestorPath.split("\u0000"));
  }, [activeKey, activeAncestorPath, expand]);
  const mutation = useMutation({
    mutationFn: async (move: WorkspaceTreeMove) => {
      const runtime = getHostRuntimeStore();
      const client = runtime.getClient(move.serverId);
      if (!client || runtime.getSnapshot(move.serverId)?.connectionStatus !== "online") {
        throw new Error("The host is disconnected. Reconnect it, then retry moving the workspace.");
      }
      const result = await client.moveWorkspace({
        workspaceId: move.workspaceId,
        parentWorkspaceId: move.parentWorkspaceId,
        beforeWorkspaceId: move.beforeWorkspaceId,
      });
      setSortMode(project.viewKey, "manual");
      useSessionStore
        .getState()
        .mergeWorkspaces(move.serverId, result.workspaces.map(normalizeWorkspaceDescriptor));
      if (move.parentWorkspaceId) expand([`${move.serverId}:${move.parentWorkspaceId}`]);
    },
  });
  const { isPending, mutate, variables, reset } = mutation;
  const manualOrder = sortMode === "manual";
  const useManualOrder = useCallback(
    () => setSortMode(project.viewKey, "manual"),
    [setSortMode, project.viewKey],
  );
  const move = useCallback(
    (request: WorkspaceTreeMove) => {
      if (!isPending) mutate(request);
    },
    [isPending, mutate],
  );
  const retry = useCallback(() => {
    if (variables) mutate(variables);
  }, [variables, mutate]);
  const canDrag = useCallback(
    (row: WorkspaceTreeRow) => hierarchySupportByServerId.get(row.workspace.serverId) === true,
    [hierarchySupportByServerId],
  );
  const renderRow = useCallback(
    (input: WorkspaceTreeRenderInput) => (
      <WorkspaceHierarchyRow
        input={input}
        collapsed={collapsedKeys.has(input.row.workspace.workspaceKey)}
        toggle={toggle}
        renderWorkspace={renderWorkspace}
      />
    ),
    [collapsedKeys, toggle, renderWorkspace],
  );
  return (
    <>
      <WorkspaceTreeDrag
        rows={rows}
        collapsedKeys={collapsedKeys}
        disabled={isPending || !manualOrder}
        canDrag={canDrag}
        onMove={move}
        renderRow={renderRow}
        testID={`sidebar-workspace-list-${project.viewKey}`}
      />
      {!manualOrder ? (
        <View style={styles.feedback}>
          <Text style={styles.message}>Use manual order to drag workspaces.</Text>
          <Button
            variant="ghost"
            size="xs"
            onPress={useManualOrder}
            testID="workspace-tree-use-manual-order"
          >
            Use manual order
          </Button>
        </View>
      ) : null}
      {mutation.isPending ? (
        <View style={styles.feedback} testID="workspace-tree-move-pending">
          <ThemedLoadingSpinner size="small" uniProps={spinnerColor} />
          <Text style={styles.message}>Moving workspace…</Text>
        </View>
      ) : null}
      {mutation.isError ? (
        <View style={styles.feedback} testID="workspace-tree-move-error" accessibilityRole="alert">
          <Text style={styles.message}>{mutation.error.message}</Text>
          <Button variant="ghost" size="xs" testID="workspace-tree-move-retry" onPress={retry}>
            Retry
          </Button>
          <Button variant="ghost" size="xs" onPress={reset}>
            Dismiss
          </Button>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  disclosure: {
    width: WORKSPACE_TREE_INDENT,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  content: { flex: 1, minWidth: 0 },
  feedback: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
  },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
