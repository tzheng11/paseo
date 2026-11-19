import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  canonicalSidebar,
  canonicalSidebarState,
  routeSidebarNavigation,
  preserveLegacySidebarStorage,
} from "./canonical-sidebar-runtime";
import {
  migrateSidebarOrderState,
  dedupeKeys,
  PinnedWorkspaceTreeSchema,
  SidebarOrderPersistedStateSchema,
} from "@getpaseo/protocol/sidebar-order";
export { migrateSidebarOrderState } from "@getpaseo/protocol/sidebar-order";
import type { SidebarWorkspaceSortMode } from "@/components/sidebar/workspace-sort";
import type {
  PinnedWorkspaceSection,
  PinnedWorkspaceTreePlacement,
} from "@/components/sidebar/workspace-tree/pinned-layout";

export type PinnedWorkspaceSortMode = SidebarWorkspaceSortMode;

interface SidebarOrderStoreState {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  superpinnedWorkspaceOrder: string[];
  pinnedWorkspaceTree: Record<string, PinnedWorkspaceTreePlacement>;
  setPinnedWorkspaceTree: (
    tree: Record<string, PinnedWorkspaceTreePlacement>,
    rootOrder?: { section: PinnedWorkspaceSection; keys: string[] },
  ) => Promise<void>;
  setSuperpinnedWorkspaceOrder: (keys: string[]) => void;
  pinnedWorkspaceSortMode: PinnedWorkspaceSortMode;
  setPinnedWorkspaceSortMode: (mode: PinnedWorkspaceSortMode) => void;
  workspaceOrderByProject: Record<string, string[]>;
  workspaceSortModeByProject: Record<string, SidebarWorkspaceSortMode>;
  setWorkspaceSortMode: (projectViewKey: string, mode: SidebarWorkspaceSortMode) => void;
  getProjectOrder: () => string[];
  setProjectOrder: (keys: string[]) => void;
  getPinnedWorkspaceOrder: () => string[];
  setPinnedWorkspaceOrder: (keys: string[]) => void;
  getWorkspaceOrder: (projectViewKey: string) => string[];
  setWorkspaceOrder: (projectViewKey: string, keys: string[]) => void;
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      superpinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: {},
      setPinnedWorkspaceTree: async (tree, rootOrder) => {
        await canonicalSidebar.ready;
        if (canonicalSidebar.state().enabled)
          throw new Error(
            "Legacy client trees are read-only. Use the shared workspace placement action.",
          );
        const previous = get();
        const update: Partial<SidebarOrderStoreState> = {
          pinnedWorkspaceTree: PinnedWorkspaceTreeSchema.parse(tree),
        };
        if (rootOrder?.section === "pinned") {
          update.pinnedWorkspaceOrder = dedupeKeys(rootOrder.keys);
          update.pinnedWorkspaceSortMode = "manual";
        } else if (rootOrder?.section === "superpinned") {
          update.superpinnedWorkspaceOrder = dedupeKeys(rootOrder.keys);
        }
        // persist's wrapped set returns the storage promise at runtime. Await it
        // so a failed durable write cannot be reported as a successful drop.
        try {
          await Promise.resolve(set(update));
        } catch (error) {
          // Validation clones the tree. Compare the actual object installed by set,
          // and restore only fields that no intervening update has replaced.
          const current = get();
          const restore: Partial<SidebarOrderStoreState> = {};
          if (current.pinnedWorkspaceTree === update.pinnedWorkspaceTree)
            restore.pinnedWorkspaceTree = previous.pinnedWorkspaceTree;
          if (
            update.pinnedWorkspaceOrder &&
            current.pinnedWorkspaceOrder === update.pinnedWorkspaceOrder
          )
            restore.pinnedWorkspaceOrder = previous.pinnedWorkspaceOrder;
          if (
            update.superpinnedWorkspaceOrder &&
            current.superpinnedWorkspaceOrder === update.superpinnedWorkspaceOrder
          )
            restore.superpinnedWorkspaceOrder = previous.superpinnedWorkspaceOrder;
          if (
            update.pinnedWorkspaceSortMode &&
            current.pinnedWorkspaceSortMode === update.pinnedWorkspaceSortMode
          )
            restore.pinnedWorkspaceSortMode = previous.pinnedWorkspaceSortMode;
          if (Object.keys(restore).length)
            await Promise.resolve(set(restore)).catch(() => undefined);
          throw error;
        }
      },
      setSuperpinnedWorkspaceOrder: (keys) => {
        if (
          routeSidebarNavigation((current) => ({
            ...current,
            superpinnedWorkspaceOrder: dedupeKeys(keys),
          }))
        )
          return;
        set({ superpinnedWorkspaceOrder: dedupeKeys(keys) });
      },
      pinnedWorkspaceSortMode: "manual",
      setPinnedWorkspaceSortMode: (mode) => {
        if (routeSidebarNavigation((current) => ({ ...current, pinnedWorkspaceSortMode: mode })))
          return;
        set({ pinnedWorkspaceSortMode: mode });
      },
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
      setWorkspaceSortMode: (projectViewKey, mode) => {
        if (!projectViewKey.trim()) return;
        if (
          routeSidebarNavigation((current) => ({
            ...current,
            workspaceSortModeByProject: {
              ...current.workspaceSortModeByProject,
              [projectViewKey]: mode,
            },
          }))
        )
          return;
        set((state) => ({
          workspaceSortModeByProject: {
            ...state.workspaceSortModeByProject,
            [projectViewKey]: mode,
          },
        }));
      },
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys) => {
        if (routeSidebarNavigation((current) => ({ ...current, projectOrder: dedupeKeys(keys) })))
          return;
        set({ projectOrder: dedupeKeys(keys) });
      },
      getPinnedWorkspaceOrder: () => get().pinnedWorkspaceOrder,
      setPinnedWorkspaceOrder: (keys) => {
        if (
          routeSidebarNavigation((current) => ({
            ...current,
            pinnedWorkspaceOrder: dedupeKeys(keys),
            pinnedWorkspaceSortMode: "manual",
          }))
        )
          return;
        set({
          pinnedWorkspaceOrder: dedupeKeys(keys),
          pinnedWorkspaceSortMode: "manual",
        });
      },
      getWorkspaceOrder: (projectViewKey) => {
        if (!projectViewKey.trim()) return [];
        return get().workspaceOrderByProject[projectViewKey] ?? [];
      },
      setWorkspaceOrder: (projectViewKey, keys) => {
        if (!projectViewKey.trim()) return;
        if (
          routeSidebarNavigation((current) => ({
            ...current,
            workspaceOrderByProject: {
              ...current.workspaceOrderByProject,
              [projectViewKey]: dedupeKeys(keys),
            },
          }))
        )
          return;
        set((state) => ({
          workspaceOrderByProject: {
            ...state.workspaceOrderByProject,
            [projectViewKey]: dedupeKeys(keys),
          },
        }));
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createValidatedPersistStorage(
        preserveLegacySidebarStorage(AsyncStorage),
        SidebarOrderPersistedStateSchema,
      ),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        pinnedWorkspaceOrder: state.pinnedWorkspaceOrder,
        superpinnedWorkspaceOrder: state.superpinnedWorkspaceOrder,
        pinnedWorkspaceTree: state.pinnedWorkspaceTree,
        pinnedWorkspaceSortMode: state.pinnedWorkspaceSortMode,
        workspaceOrderByProject: state.workspaceOrderByProject,
        workspaceSortModeByProject: state.workspaceSortModeByProject,
      }),
      version: 3,
      migrate: migrateSidebarOrderState,
      merge: (persisted, current) =>
        canonicalSidebar.state().enabled ? current : Object.assign({}, current, persisted),
    },
  ),
);

canonicalSidebarState.subscribe((state) => {
  const preferences = state.snapshot?.navigation?.preferences;
  if (state.enabled && preferences) {
    const { workspaceSort: _sort, ...orders } = preferences;
    useSidebarOrderStore.setState(orders);
  }
});
