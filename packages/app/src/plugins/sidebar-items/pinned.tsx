import { useMemo, useRef } from "react";
import { usePathname } from "expo-router";
import { View } from "react-native";
import { useInstalledPlugins } from "../registry";
import { hostIdFromPathname } from "../routes";
import { filterPluginSidebarPlacement, groupPluginSidebarItems } from "../sidebar-groups";
import { PluginSidebarItem } from "./index";

export function usePinnedPluginSidebarItems(onBeforeNavigate?: () => void) {
  const plugins = useInstalledPlugins();
  const pathname = usePathname();
  const anchorRef = useRef<View>(null);
  const groups = useMemo(
    () =>
      filterPluginSidebarPlacement(
        groupPluginSidebarItems(plugins, "header"),
        "pinned",
        hostIdFromPathname(pathname),
      ),
    [plugins, pathname],
  );
  return useMemo(
    () =>
      groups.length ? (
        <View ref={anchorRef} testID="sidebar-pinned-plugin-items">
          {groups.map((group) => (
            <PluginSidebarItem
              key={group.key}
              group={group}
              section="header"
              fallbackAnchorRef={anchorRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ))}
        </View>
      ) : null,
    [groups, onBeforeNavigate],
  );
}
