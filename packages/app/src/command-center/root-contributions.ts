import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface GroupingCommandCenterSource {
  groupMode: SidebarGroupMode;
  labels: {
    section: string;
    groupByProject: string;
    groupByStatus: string;
    groupByNone: string;
  };
  icons: {
    project?: CommandCenterIcon;
    status?: CommandCenterIcon;
    none?: CommandCenterIcon;
  };
  setGroupMode(mode: SidebarGroupMode): void;
}

export function buildGroupingContribution(
  source: GroupingCommandCenterSource,
): CommandCenterContribution {
  const next: Record<SidebarGroupMode, SidebarGroupMode> = {
    none: "project",
    project: "status",
    status: "none",
  };
  const target = next[source.groupMode];
  const titles: Record<SidebarGroupMode, string> = {
    none: source.labels.groupByNone,
    project: source.labels.groupByProject,
    status: source.labels.groupByStatus,
  };
  return {
    id: "sidebar-grouping",
    group: "actions",
    groupRank: 0,
    rank: 8,
    keywords: ["group", "grouping", "sort", "sidebar", "project", "status", "none", "hierarchy"],
    visibility: "query",
    run: () => source.setGroupMode(target),
    presentation: {
      kind: "action",
      title: titles[target],
      sectionTitle: source.labels.section,
      icon: source.icons[target],
    },
  };
}
