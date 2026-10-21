import { useTranslation } from "react-i18next";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { SidebarSectionHeader } from "./sidebar-section-header";
import { WorkspaceSortMenu } from "./workspace-sort-menu";

export function PinnedSectionHeader({
  collapsed,
  onToggle,
  title,
  testID = "sidebar-pinned-section-header",
  sortable = true,
}: {
  title?: string;
  testID?: string;
  sortable?: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const sortMode = useSidebarOrderStore((state) => state.pinnedWorkspaceSortMode);
  const setSortMode = useSidebarOrderStore((state) => state.setPinnedWorkspaceSortMode);
  return (
    <SidebarSectionHeader
      title={title ?? t("sidebar.pinned.title")}
      collapsed={collapsed}
      onToggle={onToggle}
      testID={testID}
    >
      {sortable ? (
        <WorkspaceSortMenu
          mode={sortMode}
          onSelect={setSortMode}
          testID="sidebar-pinned-sort"
          label={t("sidebar.pinned.sort.label")}
        />
      ) : null}
    </SidebarSectionHeader>
  );
}
