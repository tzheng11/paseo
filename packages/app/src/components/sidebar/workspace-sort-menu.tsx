import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react-native";
import { Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { Theme } from "@/styles/theme";
import { UNGROUPED_WORKSPACE_SORT_KEY, type SidebarWorkspaceSortMode } from "./workspace-sort";

const ThemedChevronDown = withUnistyles(ChevronDown);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const sortTriggerStyle = ({ hovered, pressed }: PressableStateCallbackType) => [
  styles.trigger,
  (hovered || pressed) && styles.triggerActive,
];
const sortModes = ["manual", "alphabetical", "activity"] as const;

export function WorkspaceSortMenu({
  mode,
  onSelect,
  testID,
  label,
}: {
  mode: SidebarWorkspaceSortMode;
  onSelect: (mode: SidebarWorkspaceSortMode) => void;
  testID: string;
  label: string;
}) {
  const { t } = useTranslation();
  const selectManual = useCallback(() => onSelect("manual"), [onSelect]);
  const selectAlphabetical = useCallback(() => onSelect("alphabetical"), [onSelect]);
  const selectActivity = useCallback(() => onSelect("activity"), [onSelect]);
  const selectMode = {
    manual: selectManual,
    alphabetical: selectAlphabetical,
    activity: selectActivity,
  };
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger accessibilityLabel={label} testID={testID} style={sortTriggerStyle}>
        <Text style={styles.title}>{t(`sidebar.workspaceSort.${mode}`)}</Text>
        <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200} sheetTitle={label}>
        {sortModes.map((option) => (
          <DropdownMenuItem
            key={option}
            selected={mode === option}
            onSelect={selectMode[option]}
            testID={`${testID}-${option}`}
          >
            {t(`sidebar.workspaceSort.${option}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectWorkspaceSortMenu({
  projectViewKey,
  projectName,
}: {
  projectViewKey: string;
  projectName: string;
}) {
  const { t } = useTranslation();
  const mode = useSidebarOrderStore(
    (state) => state.workspaceSortModeByProject[projectViewKey] ?? "manual",
  );
  const setMode = useSidebarOrderStore((state) => state.setWorkspaceSortMode);
  const onSelect = useCallback(
    (nextMode: SidebarWorkspaceSortMode) => setMode(projectViewKey, nextMode),
    [projectViewKey, setMode],
  );
  return (
    <WorkspaceSortMenu
      mode={mode}
      onSelect={onSelect}
      testID={`sidebar-project-sort-${projectViewKey}`}
      label={`${t("sidebar.workspaceSort.label")}: ${projectName}`}
    />
  );
}

export function UngroupedWorkspaceSortMenu() {
  const { t } = useTranslation();
  const mode = useSidebarOrderStore(
    (state) => state.workspaceSortModeByProject[UNGROUPED_WORKSPACE_SORT_KEY] ?? "manual",
  );
  const setMode = useSidebarOrderStore((state) => state.setWorkspaceSortMode);
  const onSelect = useCallback(
    (nextMode: SidebarWorkspaceSortMode) => setMode(UNGROUPED_WORKSPACE_SORT_KEY, nextMode),
    [setMode],
  );
  return (
    <WorkspaceSortMenu
      mode={mode}
      onSelect={onSelect}
      testID="sidebar-ungrouped-sort"
      label={t("sidebar.workspaceSort.label")}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerActive: { backgroundColor: theme.colors.interactionHighlight },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
