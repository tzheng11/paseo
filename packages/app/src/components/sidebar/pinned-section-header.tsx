import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { WorkspaceSortMenu } from "./workspace-sort-menu";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

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
      <WorkspaceSortMenu
        mode={sortMode}
        onSelect={setSortMode}
        testID="sidebar-pinned-sort"
        label={t("sidebar.pinned.sort.label")}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
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
