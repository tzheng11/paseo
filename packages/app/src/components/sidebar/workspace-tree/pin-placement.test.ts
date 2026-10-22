import { describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { applyWorkspaceTreeMove } from "./pin-placement";
import type { WorkspaceTreeDrop } from "./drop-target";
const drop: WorkspaceTreeDrop = {
  workspaceKey: "b:same",
  targetWorkspaceKey: "a:same",
  position: "inside",
  parentWorkspaceId: null,
  beforeWorkspaceId: null,
  parentWorkspaceKey: "a:same",
  pinSection: "pinned",
  pinnedOrderOnly: true,
};
const base = {
  workspaceId: "same",
  drop,
  pinned: false,
  superpinned: false,
  shouldPin: true,
  shouldSuperpin: false,
};
describe("client pinned layout membership", () => {
  it("supports offline same-section moves", async () => {
    await expect(
      applyWorkspaceTreeMove({ ...base, client: null, pinned: true }),
    ).resolves.toBeUndefined();
  });
  it("changes only the source pin flag", async () => {
    const client = {
      moveWorkspace: vi.fn(),
      setWorkspacePinned: vi.fn().mockResolvedValue({ pinnedAt: "now" }),
      setWorkspaceSuperpinned: vi.fn(),
    };
    await applyWorkspaceTreeMove({ ...base, client });
    expect(client.moveWorkspace).not.toHaveBeenCalled();
    expect(client.setWorkspacePinned).toHaveBeenCalledExactlyOnceWith("same", true);
    expect(client.setWorkspaceSuperpinned).not.toHaveBeenCalled();
  });
  it("reads a lost ACK without replaying the mutation", async () => {
    const client = {
      moveWorkspace: vi.fn(),
      setWorkspacePinned: vi.fn().mockRejectedValue(new DaemonConnectionError("lost ACK")),
      setWorkspaceSuperpinned: vi.fn(),
    };
    const confirmPinState = vi.fn().mockResolvedValue({ pinned: true, superpinned: false });
    await applyWorkspaceTreeMove({ ...base, client, confirmPinState });
    expect(client.setWorkspacePinned).toHaveBeenCalledTimes(1);
    expect(confirmPinState).toHaveBeenCalledTimes(1);
    expect(client.moveWorkspace).not.toHaveBeenCalled();
  });
  it("refuses a commit when a read confirms the pin did not happen", async () => {
    const client = {
      moveWorkspace: vi.fn(),
      setWorkspacePinned: vi.fn().mockRejectedValue(new DaemonConnectionError("timeout")),
      setWorkspaceSuperpinned: vi.fn(),
    };
    await expect(
      applyWorkspaceTreeMove({
        ...base,
        client,
        confirmPinState: async () => ({ pinned: false, superpinned: false }),
      }),
    ).rejects.toThrow("not confirmed");
    expect(client.setWorkspacePinned).toHaveBeenCalledTimes(1);
  });
});
