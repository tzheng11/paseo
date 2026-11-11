import { describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { changedPinPlacements, saveSharedPinPlacements } from "./shared-pin-placement";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import {
  applyWorkspacePinGroupChange,
  applyWorkspaceTreeMove,
  type WorkspacePinGroupMember,
  type WorkspacePinState,
} from "./pin-placement";
import type { WorkspaceTreeDrop } from "./drop-target";
import { movePinnedWorkspaceTree } from "./pinned-layout";
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

function groupMember(
  workspaceKey: string,
  initial: WorkspacePinState = { pinned: true, superpinned: false },
) {
  let state = { ...initial };
  const client = {
    moveWorkspace: vi.fn(),
    setWorkspacePinned: vi.fn(async (_id: string, pinned: boolean) => {
      state = { pinned, superpinned: pinned && state.superpinned };
      return { pinnedAt: pinned ? "now" : null };
    }),
    setWorkspaceSuperpinned: vi.fn(async (_id: string, superpinned: boolean) => {
      state = { pinned: state.pinned || superpinned, superpinned };
      return {
        pinnedAt: state.pinned ? "now" : null,
        superpinnedAt: superpinned ? "now" : null,
      };
    }),
  };
  const member: WorkspacePinGroupMember = {
    workspaceKey,
    workspaceId: workspaceKey.split(":")[1]!,
    serverId: workspaceKey.split(":")[0]!,
    ...initial,
    client,
    readPinState: vi.fn(() => ({ ...state })),
    confirmPinState: vi.fn(async () => ({ ...state })),
  };
  return {
    member,
    client,
    state: () => state,
    setState: (next: WorkspacePinState) => (state = next),
  };
}

describe("pinned subtree membership", () => {
  it("publishes a cross-host group placement after every descendant changes section", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    const workspaces = [parent, child].map(({ member }) =>
      Object.assign({}, member, {
        projectViewKey: "project",
        projectName: "Project",
        projectKind: "directory" as const,
        workspaceKind: "directory" as const,
        name: member.workspaceId,
        sidebarSection: "pinned" as const,
        pinPlacement: {
          parentWorkspaceKey: member === child.member ? "a:parent" : null,
          siblingOrder: 0,
          revision: 4,
        },
      }),
    );
    const previous = Object.fromEntries(workspaces.map((w) => [w.workspaceKey, w.pinPlacement]));
    const next = movePinnedWorkspaceTree({
      tree: previous,
      workspaces,
      workspaceKey: "a:parent",
      parentWorkspaceKey: null,
      beforeWorkspaceKey: null,
      section: "superpinned",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    // Make the root's destination rank distinct, so the shared write is observable.
    next.tree["a:parent"] = { parentWorkspaceKey: null, siblingOrder: 1024 };
    const writes: string[] = [];
    const client = {
      getLastServerInfoMessage: () => ({ features: { workspacePinPlacement: true } }),
      setWorkspacePinPlacement: vi.fn(async (input) => {
        expect(parent.state().superpinned).toBe(true);
        expect(child.state().superpinned).toBe(true);
        expect(input.expectedRevision).toBe(4);
        writes.push(input.workspaceId);
        return { ...input.placement, revision: 5 };
      }),
    };
    await applyWorkspacePinGroupChange({
      members: [parent.member, child.member],
      shouldPin: true,
      shouldSuperpin: true,
      commit: () =>
        saveSharedPinPlacements({
          updates: changedPinPlacements({ previous, next: next.tree, workspaces }),
          sourceWorkspaceKey: "a:parent",
          getClient: () => client as never,
          accepted: vi.fn(),
        }),
    });
    expect(writes).toEqual(["parent"]);
    expect(next.tree["b:child"]?.parentWorkspaceKey).toBe("a:parent");
    expect(parent.client.moveWorkspace).not.toHaveBeenCalled();
    expect(child.client.moveWorkspace).not.toHaveBeenCalled();
  });
  it("waits for every cross-host descendant ACK before committing the local tree", async () => {
    const parent = groupMember("host-a:parent");
    const child = groupMember("host-b:child");
    let finish!: () => void;
    child.client.setWorkspaceSuperpinned.mockImplementationOnce(async (_id, superpinned) => {
      await new Promise<void>((resolve) => (finish = resolve));
      child.setState({ pinned: true, superpinned });
      return { pinnedAt: "now", superpinnedAt: "now" };
    });
    const commit = vi.fn(async () => {});
    const pending = applyWorkspacePinGroupChange({
      members: [parent.member, child.member],
      shouldPin: true,
      shouldSuperpin: true,
      commit,
    });
    await vi.waitFor(() => expect(child.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1));
    expect(commit).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(parent.state()).toEqual({ pinned: true, superpinned: true });
    expect(child.state()).toEqual({ pinned: true, superpinned: true });
    expect(parent.client.moveWorkspace).not.toHaveBeenCalled();
    expect(child.client.moveWorkspace).not.toHaveBeenCalled();
    expect(parent.member.confirmPinState).not.toHaveBeenCalled();
    expect(child.member.confirmPinState).not.toHaveBeenCalled();
  });

  it("keeps same-section offline tree moves entirely local", async () => {
    const parent = groupMember("offline:parent");
    parent.member.client = null;
    const commit = vi.fn(async () => {});
    await applyWorkspacePinGroupChange({
      members: [parent.member],
      shouldPin: true,
      shouldSuperpin: false,
      commit,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(parent.member.readPinState).not.toHaveBeenCalled();
    expect(parent.member.confirmPinState).not.toHaveBeenCalled();
  });

  it.each(["missing", "disconnected"])(
    "preflights every changed descendant before any mutation when one is %s",
    async (unavailable) => {
      const parent = groupMember("a:parent");
      const child = groupMember("b:child");
      if (unavailable === "missing") child.member.readPinState = () => null;
      else child.member.client = null;
      const commit = vi.fn(async () => {});
      await expect(
        applyWorkspacePinGroupChange({
          members: [parent.member, child.member],
          shouldPin: true,
          shouldSuperpin: true,
          commit,
        }),
      ).rejects.toThrow(/unavailable|disconnected/i);
      expect(parent.client.setWorkspaceSuperpinned).not.toHaveBeenCalled();
      expect(child.client.setWorkspaceSuperpinned).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it("restores confirmed earlier descendants after a later host refuses permission", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    child.client.setWorkspaceSuperpinned.mockRejectedValueOnce(new Error("Permission denied"));
    const commit = vi.fn(async () => {});
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
        commit,
      }),
    ).rejects.toThrow(/restored.*Permission denied/i);
    expect(parent.client.setWorkspaceSuperpinned.mock.calls).toEqual([
      ["parent", true],
      ["parent", false],
    ]);
    expect(parent.state()).toEqual({ pinned: true, superpinned: false });
    expect(child.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("reconciles a lost descendant ACK without replaying its mutation", async () => {
    const child = groupMember("b:child");
    child.client.setWorkspaceSuperpinned.mockImplementationOnce(async () => {
      child.setState({ pinned: true, superpinned: true });
      throw new DaemonConnectionError("lost ACK");
    });
    const commit = vi.fn(async () => {});
    await applyWorkspacePinGroupChange({
      members: [child.member],
      shouldPin: true,
      shouldSuperpin: true,
      commit,
    });
    expect(child.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1);
    expect(child.member.confirmPinState).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does not commit when an accepted ACK does not confirm the requested membership", async () => {
    const child = groupMember("b:child", { pinned: false, superpinned: false });
    child.client.setWorkspacePinned.mockResolvedValueOnce({ pinnedAt: null });
    const commit = vi.fn(async () => {});
    await expect(
      applyWorkspacePinGroupChange({
        members: [child.member],
        shouldPin: true,
        shouldSuperpin: false,
        commit,
      }),
    ).rejects.toThrow(/not confirmed/i);
    expect(child.client.setWorkspacePinned).toHaveBeenCalledTimes(1);
    expect(child.client.moveWorkspace).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("compensates a confirmed intermediate state after the final unpin ACK is lost", async () => {
    const child = groupMember("b:child", { pinned: true, superpinned: true });
    child.client.setWorkspacePinned.mockRejectedValueOnce(
      new DaemonConnectionError("lost unpin ACK"),
    );
    const commit = vi.fn(async () => {});
    await expect(
      applyWorkspacePinGroupChange({
        members: [child.member],
        shouldPin: false,
        shouldSuperpin: false,
        commit,
      }),
    ).rejects.toThrow(/restored.*not confirmed/i);
    expect(child.client.setWorkspacePinned).toHaveBeenCalledTimes(1);
    expect(child.client.setWorkspaceSuperpinned.mock.calls).toEqual([
      ["child", false],
      ["child", true],
    ]);
    expect(child.state()).toEqual({ pinned: true, superpinned: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not compensate through an unavailable replacement host session", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    let parentSessionAvailable = true;
    parent.member.confirmPinState = vi.fn(async () =>
      parentSessionAvailable ? parent.state() : null,
    );
    child.client.setWorkspaceSuperpinned.mockImplementationOnce(async () => {
      parentSessionAvailable = false;
      throw new Error("Permission denied");
    });
    const commit = vi.fn(async () => {});
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
        commit,
      }),
    ).rejects.toThrow(/could not be restored or confirmed/i);
    expect(parent.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1);
    expect(parent.state()).toEqual({ pinned: true, superpinned: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not mutate or blindly restore a descendant whose lost ACK remains unreadable", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    child.client.setWorkspaceSuperpinned.mockRejectedValueOnce(
      new DaemonConnectionError("lost ACK"),
    );
    child.member.confirmPinState = vi.fn().mockRejectedValue(new Error("Host disconnected"));
    const commit = vi.fn(async () => {});
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
        commit,
      }),
    ).rejects.toThrow(/could not be restored or confirmed/i);
    expect(child.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1);
    expect(parent.state()).toEqual({ pinned: true, superpinned: false });
    expect(commit).not.toHaveBeenCalled();
  });

  it("restores an acknowledged intermediate superpin removal when the following unpin is refused", async () => {
    const parent = groupMember("a:parent", { pinned: true, superpinned: true });
    parent.client.setWorkspacePinned.mockRejectedValueOnce(new Error("Unpin permission denied"));
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member],
        shouldPin: false,
        shouldSuperpin: false,
      }),
    ).rejects.toThrow(/restored/i);
    expect(parent.client.setWorkspaceSuperpinned.mock.calls).toEqual([
      ["parent", false],
      ["parent", true],
    ]);
    expect(parent.client.setWorkspacePinned).toHaveBeenCalledTimes(1);
    expect(parent.state()).toEqual({ pinned: true, superpinned: true });
  });

  it("reports partial recovery when compensation is refused", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    parent.client.setWorkspaceSuperpinned.mockImplementationOnce(async () => {
      parent.setState({ pinned: true, superpinned: true });
      return { pinnedAt: "now", superpinnedAt: "now" };
    });
    parent.client.setWorkspaceSuperpinned.mockRejectedValueOnce(
      new Error("Restore permission denied"),
    );
    child.client.setWorkspaceSuperpinned.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
      }),
    ).rejects.toThrow(/could not be restored or confirmed/i);
    expect(parent.state()).toEqual({ pinned: true, superpinned: true });
  });

  it("does not overwrite a concurrently changed pin state during compensation", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    child.client.setWorkspaceSuperpinned.mockImplementationOnce(async () => {
      parent.setState({ pinned: false, superpinned: false });
      throw new Error("Permission denied");
    });
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
      }),
    ).rejects.toThrow(/could not be restored or confirmed/i);
    expect(parent.client.setWorkspaceSuperpinned).toHaveBeenCalledTimes(1);
    expect(parent.state()).toEqual({ pinned: false, superpinned: false });
  });

  it("detects a descendant snapshot change before applying its mutation", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    parent.client.setWorkspaceSuperpinned.mockImplementationOnce(async () => {
      parent.setState({ pinned: true, superpinned: true });
      child.setState({ pinned: false, superpinned: false });
      return { pinnedAt: "now", superpinnedAt: "now" };
    });
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
      }),
    ).rejects.toThrow(/changed/i);
    expect(child.client.setWorkspaceSuperpinned).not.toHaveBeenCalled();
    expect(parent.state()).toEqual({ pinned: true, superpinned: false });
  });

  it("compensates in reverse order if the local layout cannot be committed", async () => {
    const parent = groupMember("a:parent");
    const child = groupMember("b:child");
    const restored: string[] = [];
    for (const item of [parent, child]) {
      const set = item.client.setWorkspaceSuperpinned.getMockImplementation()!;
      item.client.setWorkspaceSuperpinned.mockImplementation(async (id, value) => {
        if (!value) restored.push(id);
        return set(id, value);
      });
    }
    await expect(
      applyWorkspacePinGroupChange({
        members: [parent.member, child.member],
        shouldPin: true,
        shouldSuperpin: true,
        commit: async () => {
          throw new Error("Storage unavailable");
        },
      }),
    ).rejects.toThrow(/restored.*Storage unavailable/i);
    expect(restored).toEqual(["child", "parent"]);
  });
});
