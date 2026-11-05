import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTreeDrop } from "./drop-target";

export interface WorkspacePinState {
  pinned: boolean;
  superpinned: boolean;
}

type WorkspacePinClient = Pick<
  DaemonClient,
  "moveWorkspace" | "setWorkspacePinned" | "setWorkspaceSuperpinned"
>;

export interface WorkspacePinGroupMember extends WorkspacePinState {
  workspaceKey: string;
  workspaceId: string;
  serverId: string;
  client: WorkspacePinClient | null;
  // A missing workspace or changed host session must remain distinguishable from unpinned.
  readPinState: () => WorkspacePinState | null;
  confirmPinState: () => Promise<WorkspacePinState | null>;
}

interface PinChangeProgress {
  member: WorkspacePinGroupMember;
  original: WorkspacePinState;
  known: WorkspacePinState;
  pending: WorkspacePinState | null;
}

function samePinState(left: WorkspacePinState, right: WorkspacePinState): boolean {
  return left.pinned === right.pinned && left.superpinned === right.superpinned;
}

function requirePinState(state: WorkspacePinState | null): WorkspacePinState {
  if (!state) throw new Error("Workspace unavailable. Refresh its host and retry");
  return { pinned: state.pinned, superpinned: state.superpinned };
}

async function changeGroupMember(
  progress: PinChangeProgress,
  destination: WorkspacePinState,
): Promise<void> {
  const { member } = progress;
  const client = member.client!;
  await applyWorkspaceTreeMove({
    workspaceId: member.workspaceId,
    pinned: progress.known.pinned,
    superpinned: progress.known.superpinned,
    shouldPin: destination.pinned,
    shouldSuperpin: destination.superpinned,
    // Membership changes never move a descendant's host-owned workspace or filesystem.
    drop: {
      workspaceKey: member.workspaceKey,
      targetWorkspaceKey: member.workspaceKey,
      position: "before",
      parentWorkspaceId: null,
      beforeWorkspaceId: null,
      pinnedOrderOnly: true,
    },
    client: {
      moveWorkspace: client.moveWorkspace.bind(client),
      setWorkspaceSuperpinned: async (workspaceId, superpinned) => {
        progress.pending = {
          pinned: progress.known.pinned || superpinned,
          superpinned,
        };
        try {
          const result = await client.setWorkspaceSuperpinned(workspaceId, superpinned);
          progress.known = {
            pinned: result.pinnedAt !== null || result.superpinnedAt !== null,
            superpinned: result.superpinnedAt !== null,
          };
          progress.pending = null;
          return result;
        } catch (error) {
          if (!(error instanceof DaemonConnectionError)) progress.pending = null;
          throw error;
        }
      },
      setWorkspacePinned: async (workspaceId, pinned) => {
        progress.pending = {
          pinned,
          superpinned: pinned && progress.known.superpinned,
        };
        try {
          const result = await client.setWorkspacePinned(workspaceId, pinned);
          progress.known = {
            pinned: result.pinnedAt !== null,
            superpinned: result.pinnedAt !== null && progress.known.superpinned,
          };
          progress.pending = null;
          return result;
        } catch (error) {
          if (!(error instanceof DaemonConnectionError)) progress.pending = null;
          throw error;
        }
      },
    },
    confirmPinState: async () => {
      const observed = requirePinState(await member.confirmPinState());
      if (
        samePinState(observed, progress.known) ||
        (progress.pending && samePinState(observed, progress.pending))
      ) {
        progress.known = observed;
        progress.pending = null;
      }
      return observed;
    },
  });
  if (progress.pending || !samePinState(progress.known, destination))
    throw new Error("Pin change was not confirmed. Check its current priority and retry");
}

async function restoreGroupMembership(attempted: readonly PinChangeProgress[]): Promise<boolean> {
  let incompleteRecovery = false;
  for (const progress of attempted.toReversed()) {
    if (!progress.pending && samePinState(progress.known, progress.original)) continue;
    try {
      const observed = requirePinState(await progress.member.confirmPinState());
      if (samePinState(observed, progress.original)) continue;
      const isOurKnownState = samePinState(observed, progress.known);
      const isOurPendingState =
        progress.pending !== null && samePinState(observed, progress.pending);
      if (!isOurKnownState && !isOurPendingState) {
        incompleteRecovery = true;
        continue;
      }
      progress.known = observed;
      progress.pending = null;
      await changeGroupMember(progress, progress.original);
    } catch {
      incompleteRecovery = true;
    }
  }
  return incompleteRecovery;
}

/**
 * Changes explicit section membership on each owning host before committing the local tree.
 * Hosts do not share a transaction: failure restores only our confirmed, still-current changes.
 */
export async function applyWorkspacePinGroupChange(input: {
  members: readonly WorkspacePinGroupMember[];
  shouldPin: boolean;
  shouldSuperpin: boolean;
  commit?: () => Promise<void>;
}): Promise<void> {
  const destination = {
    pinned: input.shouldPin,
    superpinned: input.shouldSuperpin,
  };
  if (destination.superpinned && !destination.pinned)
    throw new Error("SuperPinned workspaces must also be pinned");
  const keys = new Set<string>();
  const changes: PinChangeProgress[] = [];
  for (const source of input.members) {
    if (keys.has(source.workspaceKey)) throw new Error("Duplicate workspace in pin group");
    keys.add(source.workspaceKey);
    const member = { ...source };
    const original = { pinned: member.pinned, superpinned: member.superpinned };
    if (samePinState(original, destination)) continue;
    if (!member.client) throw new Error("Host disconnected. Reconnect and retry");
    if (!samePinState(requirePinState(member.readPinState()), original))
      throw new Error("Workspace pin status changed. Refresh the group and retry");
    changes.push({ member, original, known: original, pending: null });
  }

  const attempted: PinChangeProgress[] = [];
  try {
    for (const progress of changes) {
      // Another host or window may have changed a later descendant while earlier ACKs arrived.
      if (!samePinState(requirePinState(progress.member.readPinState()), progress.original))
        throw new Error("Workspace pin status changed. Refresh the group and retry");
      attempted.push(progress);
      await changeGroupMember(progress, destination);
    }
    await input.commit?.();
  } catch (error) {
    const incompleteRecovery = await restoreGroupMembership(attempted);
    const detail = error instanceof Error ? error.message : "Pin change failed";
    throw new Error(
      incompleteRecovery
        ? `Could not finish moving this group. Some pin changes could not be restored or confirmed. Check each workspace's pin status before retrying. ${detail}`
        : `Could not move this group. Confirmed pin changes were restored. ${detail}`,
      { cause: error },
    );
  }
}

export async function applyWorkspaceTreeMove(input: {
  client: WorkspacePinClient | null;
  workspaceId: string;
  drop: WorkspaceTreeDrop;
  pinned: boolean;
  superpinned: boolean;
  shouldPin: boolean;
  shouldSuperpin: boolean;
  confirmPinState?: () => Promise<{ pinned: boolean; superpinned: boolean }>;
}): Promise<void> {
  const { client, workspaceId, drop, shouldPin, shouldSuperpin } = input;
  if (drop.pinnedOrderOnly && input.pinned === shouldPin && input.superpinned === shouldSuperpin)
    return;
  if (!client) throw new Error("Host disconnected. Reconnect and retry");
  if (!drop.pinnedOrderOnly)
    await client.moveWorkspace(workspaceId, {
      parentWorkspaceId: null,
      beforeWorkspaceId: drop.beforeWorkspaceId,
    });
  try {
    let pinned = input.pinned;
    if (input.superpinned !== shouldSuperpin)
      pinned =
        (await client.setWorkspaceSuperpinned(workspaceId, shouldSuperpin)).pinnedAt !== null;
    if (pinned !== shouldPin) await client.setWorkspacePinned(workspaceId, shouldPin);
  } catch (error) {
    if (!(error instanceof DaemonConnectionError) || !input.confirmPinState) throw error;
    // A lost ACK may already have changed the pin. Read it; never replay the mutation blindly.
    const confirmed = await input.confirmPinState();
    if (confirmed.pinned !== shouldPin || confirmed.superpinned !== shouldSuperpin)
      throw new Error("Pin change was not confirmed. Check its current priority and retry", {
        cause: error,
      });
  }
}
