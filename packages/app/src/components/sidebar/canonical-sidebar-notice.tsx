import {
  canonicalSidebar,
  canonicalSidebarState,
  useCanonicalSidebarState,
} from "@/stores/canonical-sidebar-runtime";
import { SidebarCallout } from "@/components/sidebar-callout";

export function CanonicalSidebarNotice() {
  const state = useCanonicalSidebarState();
  if (!state.enabled || (state.writable && !state.actionError)) return null;
  if (state.saving)
    return <SidebarCallout testID="canonical-sidebar-layout-saving" title="Saving shared layout" />;
  const importing = state.snapshot?.stamp.phase === "importing";
  const refresh = () => {
    canonicalSidebarState.setState({ actionError: null });
    void canonicalSidebar.reconcile().catch((error) =>
      canonicalSidebarState.setState({
        actionError:
          error instanceof Error ? error.message : "Shared layout could not be refreshed.",
      }),
    );
  };
  return (
    <SidebarCallout
      testID="canonical-sidebar-layout-status"
      title={importing ? "Shared layout is being imported" : "Shared layout is read-only"}
      description={
        state.actionError ??
        state.error ??
        "Your saved layout remains visible. Reconnect its authority to edit it."
      }
      actions={[
        { label: state.pending ? "Check saved change" : "Refresh shared layout", onPress: refresh },
      ]}
    />
  );
}
