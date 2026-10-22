import { describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { changedPinPlacements, saveSharedPinPlacements } from "./shared-pin-placement";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
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

describe("shared pin placement commits", () => {
  const workspace = (key: string): SidebarWorkspacePlacement => ({
    workspaceKey: key,
    workspaceId: key,
    serverId: "host",
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "directory",
    workspaceKind: "directory",
    name: key,
    pinPlacement: { parentWorkspaceKey: null, siblingOrder: 0, revision: 4 },
  });
  it("writes rebalance ranks before the source and carries captured revisions", async () => {
    const workspaces = [workspace("source"), workspace("sibling")];
    const updates = changedPinPlacements({
      previous: {},
      next: {
        source: { parentWorkspaceKey: "remote:parent", siblingOrder: 512 },
        sibling: { parentWorkspaceKey: null, siblingOrder: 1024 },
      },
      workspaces,
    });
    const calls: string[] = [];
    const client = {
      getLastServerInfoMessage: () => ({ features: { workspacePinPlacement: true } }),
      setWorkspacePinPlacement: vi.fn(async (input) => {
        calls.push(input.workspaceId);
        expect(input.expectedRevision).toBe(4);
        return { ...input.placement, revision: 5 };
      }),
    };
    const accepted = vi.fn();
    await saveSharedPinPlacements({
      updates,
      sourceWorkspaceKey: "source",
      getClient: () => client as never,
      accepted,
    });
    expect(calls).toEqual(["sibling", "source"]);
    expect(accepted).toHaveBeenCalledTimes(2);
  });
  it("checks every owning host before performing any mutation", async () => {
    const workspaces = [workspace("source"), { ...workspace("sibling"), serverId: "old-host" }];
    const updates = changedPinPlacements({
      previous: {},
      next: Object.fromEntries(
        workspaces.map((w) => [w.workspaceKey, { parentWorkspaceKey: null, siblingOrder: 1 }]),
      ),
      workspaces,
    });
    const client = {
      getLastServerInfoMessage: () => ({ features: { workspacePinPlacement: true } }),
      setWorkspacePinPlacement: vi.fn(),
    };
    const old = { getLastServerInfoMessage: () => ({ features: {} }) };
    await expect(
      saveSharedPinPlacements({
        updates,
        sourceWorkspaceKey: "source",
        getClient: (id) => (id === "old-host" ? old : client) as never,
        accepted: vi.fn(),
      }),
    ).rejects.toThrow("Update this host");
    expect(client.setWorkspacePinPlacement).not.toHaveBeenCalled();
  });
});
