import AsyncStorage from "@react-native-async-storage/async-storage";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { StateStorage } from "zustand/middleware";
import type {
  WorkspaceNavigationPreferences,
  WorkspaceLayoutSnapshot,
  WorkspaceLayoutMutation,
} from "@getpaseo/protocol/workspace-layout";
import {
  CanonicalSidebarLayout,
  CANONICAL_SIDEBAR_REPLICA_KEY,
  type CanonicalSidebarState,
} from "./canonical-sidebar-layout";

export const canonicalSidebarState = createStore<
  CanonicalSidebarState & { actionError: string | null }
>(() => ({
  loaded: false,
  enabled: false,
  snapshot: null,
  writable: false,
  pending: false,
  saving: false,
  error: null,
  actionError: null,
}));
export const canonicalSidebar = new CanonicalSidebarLayout({
  read: () => AsyncStorage.getItem(CANONICAL_SIDEBAR_REPLICA_KEY),
  write: (bytes) => AsyncStorage.setItem(CANONICAL_SIDEBAR_REPLICA_KEY, bytes),
  hash: async (bytes) => {
    const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
    return digestStringAsync(CryptoDigestAlgorithm.SHA256, bytes);
  },
  requestId: () => globalThis.crypto.randomUUID(),
  changed: (state) => canonicalSidebarState.setState(state),
});

export function useCanonicalSidebarState() {
  return useStore(canonicalSidebarState);
}

/** Returns true when the action was handled centrally or refused; never falls through on a failed route. */
export function routeSidebarNavigation(
  change: (current: WorkspaceNavigationPreferences) => WorkspaceNavigationPreferences,
): boolean {
  const state = canonicalSidebar.state();
  if (state.loaded && !state.enabled) return false;
  void saveSidebarNavigation(change).catch((error) => {
    canonicalSidebarState.setState({
      actionError: error instanceof Error ? error.message : "Shared layout could not be saved.",
    });
  });
  return true;
}
export async function saveSidebarNavigation(
  change: (current: WorkspaceNavigationPreferences) => WorkspaceNavigationPreferences,
): Promise<void> {
  canonicalSidebarState.setState({ actionError: null });
  await canonicalSidebar.update(change);
}
export async function saveSidebarLayout(
  build: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceLayoutMutation[],
): Promise<void> {
  canonicalSidebarState.setState({ actionError: null });
  await canonicalSidebar.mutate(build);
}

/** Preserve the original client import bytes. Canonical observations use a separate read-replica key. */
export function preserveLegacySidebarStorage(
  backing: StateStorage,
  replicaNamespace?: string,
): StateStorage {
  return {
    getItem: async (name) => {
      if (!canonicalSidebar.state().loaded) await canonicalSidebar.ready;
      if (!canonicalSidebar.state().enabled) return backing.getItem(name);
      if (!replicaNamespace) return null;
      return (await backing.getItem(`${replicaNamespace}:${name}`)) ?? backing.getItem(name);
    },
    setItem: async (name, value) => {
      if (!canonicalSidebar.state().loaded) await canonicalSidebar.ready;
      if (!canonicalSidebar.state().enabled) await backing.setItem(name, value);
      else if (replicaNamespace) await backing.setItem(`${replicaNamespace}:${name}`, value);
    },
    removeItem: async (name) => {
      if (!canonicalSidebar.state().loaded) await canonicalSidebar.ready;
      if (!canonicalSidebar.state().enabled) await backing.removeItem(name);
      else if (replicaNamespace) await backing.removeItem(`${replicaNamespace}:${name}`);
    },
  };
}
