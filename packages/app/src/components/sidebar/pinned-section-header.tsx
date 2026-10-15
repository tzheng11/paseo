import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const sortTriggerStyle = ({ hovered, pressed }: PressableStateCallbackType) => [
  styles.sortTrigger,
  (hovered || pressed) && styles.sortTriggerActive,
];

export function PinnedSectionHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const sortMode = useSidebarOrderStore((state) => state.pinnedWorkspaceSortMode);
  const setSortMode = useSidebarOrderStore((state) => state.setPinnedWorkspaceSortMode);
  const selectManual = useCallback(() => setSortMode("manual"), [setSortMode]);
  const selectAlphabetical = useCallback(() => setSortMode("alphabetical"), [setSortMode]);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={onToggle}
        style={styles.header}
        testID="sidebar-pinned-section-header"
      >
        {({ hovered }) => (
          <>
            <Text style={styles.title}>{t("sidebar.pinned.title")}</Text>
            {hovered || isNative || isCompact ? (
              <Chevron size={12} uniProps={foregroundMutedColorMapping} />
            ) : null}
          </>
        )}
      </Pressable>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityLabel={t("sidebar.pinned.sort.label")}
          testID="sidebar-pinned-sort"
          style={sortTriggerStyle}
        >
          <Text style={styles.title}>
            {t(
              sortMode === "alphabetical"
                ? "sidebar.pinned.sort.alphabetical"
                : "sidebar.pinned.sort.manual",
            )}
          </Text>
          <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={200} sheetTitle={t("sidebar.pinned.sort.label")}>
          <DropdownMenuItem
            selected={sortMode === "manual"}
            onSelect={selectManual}
            testID="sidebar-pinned-sort-manual"
          >
            {t("sidebar.pinned.sort.manual")}
          </DropdownMenuItem>
          <DropdownMenuItem
            selected={sortMode === "alphabetical"}
            onSelect={selectAlphabetical}
            testID="sidebar-pinned-sort-alphabetical"
          >
            {t("sidebar.pinned.sort.alphabetical")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sortTrigger: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  sortTriggerActive: { backgroundColor: theme.colors.interactionHighlight },
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
