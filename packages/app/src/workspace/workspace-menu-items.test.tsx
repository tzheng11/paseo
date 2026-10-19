// @vitest-environment jsdom
import React, { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capable: null as boolean | null,
  connected: true,
  superpinnedAt: null as string | null,
  toggle: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureAvailability: () => state.capable }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => state.connected }));
vi.mock("@/hooks/use-sidebar-workspace-pin", () => ({
  useWorkspacePinPending: () => false,
  useSidebarWorkspaceSuperpinController: () => state.toggle,
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceFields: () => ({ id: "w1", pinnedAt: null, superpinnedAt: state.superpinnedAt }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: MenuItem,
  DropdownMenuSubTrigger: () => null,
}));
vi.mock("@/components/ui/context-menu", () => ({ ContextMenuItem: MenuItem }));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("@/workspace/open-in-file-manager/menu-item", () => ({
  OpenInFileManagerMenuItem: () => null,
}));
vi.mock("@/workspace-labels/picker", () => ({ WORKSPACE_LABEL_PAGE_ID: "labels" }));

function MenuItem({
  children,
  disabled,
  onSelect,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return createElement("button", { type: "button", disabled, onClick: onSelect }, children);
}

vi.stubGlobal("React", React);
const { WorkspaceMenuItems } = await import("./workspace-menu-items");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

for (const surface of ["context", "dropdown"] as const) {
  describe(`3fdb71dd-7bc7-81fe-9280-c37f47c8e4b9@c0b2fb81314b#old-daemon ${surface} row/header menu`, () => {
    for (const superpinnedAt of [null, "2026-10-18T22:00:00Z"]) {
      it.each([null, false, true])(
        `gates superpin with stored priority ${superpinnedAt} and capability %s`,
        (capable) => {
          state.capable = capable;
          state.connected = true;
          state.superpinnedAt = superpinnedAt;
          const label = superpinnedAt ? "sidebar.superpinned.remove" : "sidebar.superpinned.action";
          const view = render(
            createElement(WorkspaceMenuItems, {
              surface,
              serverId: "host",
              workspaceId: "w1",
              workspaceKey: "host:w1",
            }),
          );
          if (capable === true) {
            const action = view.getByRole("button", { name: label }) as HTMLButtonElement;
            expect(action.disabled).toBe(false);
            fireEvent.click(action);
            expect(state.toggle).toHaveBeenCalledExactlyOnceWith({
              serverId: "host",
              workspaceId: "w1",
              workspaceKey: "host:w1",
              pinnedAt: null,
              superpinnedAt,
            });
          } else {
            expect(view.queryByRole("button", { name: /sidebar.superpinned/ })).toBeNull();
            expect(state.toggle).not.toHaveBeenCalled();
          }
        },
      );
      it(`retains a disabled action for last-known support while disconnected, priority ${superpinnedAt}`, () => {
        state.capable = true;
        state.connected = false;
        state.superpinnedAt = superpinnedAt;
        const view = render(
          createElement(WorkspaceMenuItems, {
            surface,
            serverId: "host",
            workspaceId: "w1",
            workspaceKey: "host:w1",
          }),
        );
        const action = view.getByRole("button", {
          name: /sidebar.superpinned/,
        }) as HTMLButtonElement;
        expect(action.disabled).toBe(true);
        fireEvent.click(action);
        expect(state.toggle).not.toHaveBeenCalled();
      });
    }
  });
}
