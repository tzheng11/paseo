import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { WorkspaceTreeRow } from ".";
import { flattenWorkspaceTree } from "./model";

export function SidebarWorkspaceTreeList<T extends SidebarWorkspacePlacement>({
  data,
  renderItem,
  testID,
  sortSiblings = true,
}: {
  data: T[];
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  testID: string;
  sortSiblings?: boolean;
}) {
  const collapsedKeys = useSidebarCollapsedSectionsStore((state) => state.collapsedWorkspaceKeys);
  const rows = useMemo(
    () => flattenWorkspaceTree(data, collapsedKeys, sortSiblings),
    [data, collapsedKeys, sortSiblings],
  );
  const byKey = useMemo(() => new Map(data.map((item) => [item.workspaceKey, item])), [data]);
  return (
    <View testID={testID}>
      {rows.map((row, index) => {
        const item = byKey.get(row.workspace.workspaceKey);
        if (!item) return null;
        return (
          <WorkspaceTreeRow key={row.workspace.workspaceKey} {...row}>
            {renderItem({ item, index, drag: noop, isActive: false })}
          </WorkspaceTreeRow>
        );
      })}
    </View>
  );
}
function noop() {}
