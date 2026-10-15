import { expect, test } from "vitest";
import {
  closeTabInLayout,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  findPaneById,
  restoreWorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { getPanelManifest } from "@/panels/panel-manifest";

test("Info is a permanent explorer singleton and survives individual and bulk close", () => {
  let layout = createWorkspaceLayoutWithExplorerSidebar();
  expect(getPanelManifest("info")).toMatchObject({
    permanent: true,
    singleton: true,
    supportedHosts: ["explorer"],
    showCloseButton: false,
  });
  expect(closeTabInLayout({ layout, tabId: "info", explorerSidebarPaneId: "explorer" })).toBeNull();
  for (const tab of collectAllTabs(layout.root))
    layout =
      closeTabInLayout({ layout, tabId: tab.tabId, explorerSidebarPaneId: "explorer" }) ?? layout;
  expect(collectAllTabs(layout.root).filter((t) => t.target.kind === "info")).toHaveLength(1);
});

test.each(["files", "changes_tree"])(
  "legacy explorer preserves selected %s and gains Info once",
  (selected) => {
    const layout = createWorkspaceLayoutWithExplorerSidebar();
    const pane = findPaneById(layout.root, "explorer")!;
    const legacy = {
      ...pane,
      tabIds: ["files", "changes_tree"],
      tabs: collectAllTabs(layout.root).filter((t) => ["files", "changes_tree"].includes(t.tabId)),
      focusedTabId: selected,
    };
    if (layout.root.kind !== "group") throw new Error("Expected group");
    layout.root.group.children[1] = { kind: "pane", pane: legacy };
    const restored = restoreWorkspaceLayout(layout, "explorer");
    expect(findPaneById(restored.root, "explorer")?.focusedTabId).toBe(selected);
    expect(collectAllTabs(restored.root).filter((t) => t.target.kind === "info")).toHaveLength(1);
    const repeated = restoreWorkspaceLayout(restored, "explorer");
    expect(repeated).toEqual(restored);
  },
);
