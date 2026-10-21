import { useCallback, useMemo, type ReactNode } from "react";
import type { Theme } from "@/styles/theme";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useWorkspaceTreeDrag } from "./controller";
import type { WorkspaceTreeDrop } from "./drop-target";
export const WORKSPACE_TREE_INDENT = 16;
export interface WorkspaceTreeRowProps {
  workspace: SidebarWorkspacePlacement;
  depth: number;
  hasChildren: boolean;
  children: ReactNode;
}
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
export const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const expandIcon = <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />;
const collapseIcon = <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />;
export function WorkspaceTreeRowChrome({
  workspace,
  depth,
  hasChildren,
  children,
  handle,
}: WorkspaceTreeRowProps & { handle: ReactNode }) {
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceKeys.has(workspace.workspaceKey),
  );
  const toggle = useSidebarCollapsedSectionsStore((state) => state.toggleWorkspaceCollapsed);
  const drag = useWorkspaceTreeDrag();
  const handleToggle = useCallback(
    () => toggle(workspace.workspaceKey),
    [toggle, workspace.workspaceKey],
  );
  const accessibilityValue = useMemo(() => ({ now: depth }), [depth]);
  const collapseVisual = collapsed ? expandIcon : collapseIcon;
  const target = drag.drop?.targetWorkspaceKey === workspace.workspaceKey ? drag.drop : null;
  const blocked =
    drag.rejection?.targetWorkspaceKey === workspace.workspaceKey ? drag.rejection : null;
  const targetName = target
    ? (drag.workspaces.find((item) => item.workspaceKey === workspace.workspaceKey)?.name ??
      workspace.name)
    : workspace.name;
  return (
    <View
      style={[
        styles.row,
        { marginLeft: depth * WORKSPACE_TREE_INDENT },
        drag.activeSubtreeKeys.has(workspace.workspaceKey) && styles.dragging,
      ]}
      testID={`workspace-tree-node-${workspace.workspaceKey}`}
      accessibilityValue={accessibilityValue}
    >
      <View style={styles.controls}>
        {handle}
        {hasChildren ? (
          <Button
            variant="ghost"
            size="xs"
            style={styles.toggle}
            accessibilityLabel={collapsed ? "Expand workspace" : "Collapse workspace"}
            testID={`workspace-tree-toggle-${workspace.workspaceKey}`}
            onPress={handleToggle}
            leftIcon={collapseVisual}
          />
        ) : (
          <View style={styles.toggle} />
        )}
      </View>
      <View style={styles.content}>{children}</View>
      {target ? <WorkspaceTreeDropIndicator drop={target} targetName={targetName} /> : null}
      {blocked ? (
        <View
          pointerEvents="none"
          testID="workspace-tree-drop-blocked"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[styles.inside, styles.blocked]}
        >
          <Text numberOfLines={2} style={[styles.dropLabel, styles.blockedText]}>
            {blocked.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
export function WorkspaceTreeDropIndicator({
  drop,
  targetName,
}: {
  drop: WorkspaceTreeDrop;
  targetName: string;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      testID={`workspace-tree-drop-${drop.position}`}
      style={
        drop.position === "inside"
          ? styles.inside
          : [styles.line, drop.position === "before" ? styles.before : styles.after]
      }
    >
      {drop.position === "inside" ? (
        <Text numberOfLines={2} style={styles.dropLabel}>
          Nest under “{targetName}”
        </Text>
      ) : null}
    </View>
  );
}
const dropActionLabels = { inside: "Nest under", before: "Move before", after: "Move after" };
export function WorkspaceTreeDragPreview({ name }: { name: string }) {
  const drag = useWorkspaceTreeDrag();
  const target = drag.drop
    ? drag.workspaces.find((workspace) => workspace.workspaceKey === drag.drop?.targetWorkspaceKey)
    : null;
  const action = drag.drop
    ? `${dropActionLabels[drag.drop.position]} “${target?.name ?? "workspace"}”`
    : null;
  const message = drag.rejection?.message ?? action;
  return (
    <>
      <Text numberOfLines={1} style={workspaceTreeStyles.ghostText}>
        {name}
      </Text>
      {message ? (
        <Text
          numberOfLines={3}
          accessibilityLiveRegion="polite"
          testID="workspace-tree-drag-feedback"
          style={[workspaceTreeStyles.ghostFeedback, drag.rejection && styles.blockedText]}
        >
          {message}
        </Text>
      ) : null}
    </>
  );
}
export const workspaceTreeStyles = StyleSheet.create((theme) => ({
  handle: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    minHeight: 32,
  },
  ghost: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    maxWidth: 320,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  ghostText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  ghostFeedback: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
const styles = StyleSheet.create((theme) => ({
  row: { position: "relative", flexDirection: "row", alignItems: "center" },
  controls: { flexDirection: "row", alignItems: "center" },
  toggle: { width: 16, minWidth: 16, paddingHorizontal: 0, borderWidth: 0 },
  content: { flex: 1, minWidth: 0 },
  dragging: { opacity: 0.4 },
  line: {
    position: "absolute",
    left: 14,
    right: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
    zIndex: 2,
  },
  before: { top: 0 },
  after: { bottom: 0 },
  inside: {
    position: "absolute",
    inset: 0,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.interactionHighlight,
    borderRadius: theme.borderRadius.md,
    alignItems: "flex-end",
    justifyContent: "flex-end",
  },
  dropLabel: {
    maxWidth: "100%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surfaceSidebar,
  },
  blocked: {
    borderColor: theme.colors.destructive,
    alignItems: "stretch",
    justifyContent: "center",
  },
  blockedText: { color: theme.colors.destructive, flexShrink: 1, textAlign: "center" },
}));
