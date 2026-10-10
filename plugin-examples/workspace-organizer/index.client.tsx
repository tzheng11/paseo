import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrganizationSidebar } from "./client/sidebar";
import { OrganizationScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "organization",
    title: "Workspace organization",
    Component: OrganizationScreen,
  });
  client.addSidebarHeaderItem({
    id: "organization",
    title: "Workspace organization",
    Component: OrganizationSidebar,
  });
  client.addCommandCenterItem({
    id: "organization",
    title: "Organize workspaces",
    icon: "FolderTree",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "organization" }),
  });
  return () => {};
}
