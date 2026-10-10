import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrganizationSidebar } from "./client/sidebar";
import { OrganizationScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "organization",
    title: "Pinned folders",
    Component: OrganizationScreen,
  });
  client.addSidebarHeaderItem({
    id: "organization",
    title: "Pinned folders",
    placement: "pinned",
    Component: OrganizationSidebar,
  });
  client.addCommandCenterItem({
    id: "organization",
    title: "Organize pinned folders",
    icon: "FolderTree",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "organization" }),
  });
  return () => {};
}
