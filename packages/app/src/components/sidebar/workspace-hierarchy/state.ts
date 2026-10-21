import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const PersistedWorkspaceTreeSchema = z.object({ collapsedKeys: z.array(z.string()) });
interface WorkspaceTreeState {
  collapsedKeys: string[];
  toggle: (key: string) => void;
  expand: (keys: readonly string[]) => void;
}

export const useWorkspaceTreeStore = create<WorkspaceTreeState>()(
  persist(
    (set) => ({
      collapsedKeys: [],
      toggle: (key) =>
        set((state) => ({
          collapsedKeys: state.collapsedKeys.includes(key)
            ? state.collapsedKeys.filter((collapsed) => collapsed !== key)
            : [...state.collapsedKeys, key],
        })),
      expand: (keys) =>
        set((state) => {
          const collapsedKeys = state.collapsedKeys.filter((key) => !keys.includes(key));
          return collapsedKeys.length === state.collapsedKeys.length ? state : { collapsedKeys };
        }),
    }),
    {
      name: "sidebar-workspace-tree",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedWorkspaceTreeSchema),
      partialize: (state) => ({ collapsedKeys: state.collapsedKeys }),
    },
  ),
);
