import { Info } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { WorkspaceFieldsContent } from "@/workspace-fields/content";
const ThemedInfo = withUnistyles(Info);
function InfoPanel() {
  const { serverId, workspaceId } = usePaneContext();
  return (
    <WorkspaceFieldsContent
      key={`${serverId}:${workspaceId}`}
      serverId={serverId}
      workspaceId={workspaceId}
    />
  );
}
export const infoPanelRegistration = definePanel("info", {
  component: InfoPanel,
  presentation: {
    label: (t) => t("panels.info.label"),
    subtitle: (t) => t("panels.info.fields"),
    tooltip: (t) => t("panels.info.label"),
    icon: ThemedInfo,
  },
});
