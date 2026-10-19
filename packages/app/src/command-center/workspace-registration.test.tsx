// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capable: null as boolean | null,
  connected: true,
  toggle: vi.fn(),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureAvailability: () => state.capable }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => state.connected }));
vi.mock("@/hooks/use-sidebar-workspace-pin", () => ({
  useWorkspacePinPending: () => false,
  useSidebarWorkspaceSuperpinController: () => state.toggle,
}));
vi.mock("@/git/use-actions", () => ({}));
vi.mock("@/hooks/use-workspace-clipboard-actions", () => ({}));
vi.mock("@/keyboard/keyboard-action-dispatcher-context", () => ({}));
vi.mock("@/workspace-labels", () => ({}));
vi.mock("./provider", () => ({}));

vi.stubGlobal("React", React);
const { useWorkspaceSuperpinCommand } = await import("./workspace-registration");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("3fdb71dd-7bc7-81fe-9280-c37f47c8e4b9@c0b2fb81314b#old-daemon command-center registration", () => {
  for (const superpinnedAt of [null, "2026-10-18T22:00:00Z"]) {
    it.each([null, false, true])(
      `gates entry with stored priority ${superpinnedAt} and capability %s`,
      (capable) => {
        state.capable = capable;
        state.connected = true;
        const fields = { id: "w1", pinnedAt: null, superpinnedAt };
        const { result } = renderHook(() => useWorkspaceSuperpinCommand("host", "host:w1", fields));
        if (capable === true) {
          expect(result.current.superpin).toMatchObject({
            isSuperpinned: superpinnedAt != null,
            disabled: false,
          });
          act(() => result.current.superpin!.run());
          expect(state.toggle).toHaveBeenCalledExactlyOnceWith({
            serverId: "host",
            workspaceId: "w1",
            workspaceKey: "host:w1",
            pinnedAt: null,
            superpinnedAt,
          });
        } else {
          expect(result.current.superpin).toBeUndefined();
          expect(state.toggle).not.toHaveBeenCalled();
        }
      },
    );
    it(`retains a disabled entry for last-known support while disconnected, priority ${superpinnedAt}`, () => {
      state.capable = true;
      state.connected = false;
      const { result } = renderHook(() =>
        useWorkspaceSuperpinCommand("host", "host:w1", { id: "w1", pinnedAt: null, superpinnedAt }),
      );
      expect(result.current.superpin).toMatchObject({
        isSuperpinned: superpinnedAt != null,
        disabled: true,
      });
      act(() => result.current.superpin!.run());
      expect(state.toggle).not.toHaveBeenCalled();
    });
  }
});
