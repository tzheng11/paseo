import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
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

interface SidebarOrderPersistedState {
  projectOrder?: string[];
  pinnedWorkspaceOrder?: string[];
  superpinnedWorkspaceOrder?: string[];
  pinnedWorkspaceTree?: Record<string, PinnedWorkspaceTreePlacement>;
  pinnedWorkspaceSortMode?: PinnedWorkspaceSortMode;
  workspaceOrderByProject?: Record<string, string[]>;
  workspaceSortModeByProject?: Record<string, SidebarWorkspaceSortMode>;
  projectOrderByServerId?: Record<string, string[]>;
  workspaceOrderByServerAndProject?: Record<string, string[]>;
}

const WorkspaceSortModeSchema = z.enum(["manual", "alphabetical", "activity"]);
const StringArrayRecordSchema = z.record(z.string(), z.array(z.string()));
const PinnedWorkspaceTreeSchema = z.record(
  z.string(),
  z.strictObject({
    parentWorkspaceKey: z.string().nullable(),
    siblingOrder: z.number().finite(),
  }),
);
const SidebarOrderPersistedStateSchema = z.strictObject({
  projectOrder: z.array(z.string()).optional(),
  pinnedWorkspaceOrder: z.array(z.string()).optional(),
  superpinnedWorkspaceOrder: z.array(z.string()).optional(),
  pinnedWorkspaceTree: PinnedWorkspaceTreeSchema.catch({}).optional(),
  pinnedWorkspaceSortMode: WorkspaceSortModeSchema.optional(),
  workspaceSortModeByProject: z.record(z.string(), WorkspaceSortModeSchema).optional(),
  workspaceOrderByProject: StringArrayRecordSchema.optional(),
  projectOrderByServerId: StringArrayRecordSchema.optional(),
  workspaceOrderByServerAndProject: StringArrayRecordSchema.optional(),
});

interface SidebarWorkspaceOrderScope {
  serverId: string;
  projectViewKey: string;
}

// Trims keys from pre-v2 persisted formats, where stray spaces were artifacts
// rather than part of an exact project or workspace key.
function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

/**
 * Drops blank keys and duplicates but keeps each key exactly as given. View
 * keys embed a project's path, so a directory whose name ends in a space
 * produces a key that ends in a space. Trimming it stores a key that can never
 * match the one the sidebar looks up, so the caller sees its key as missing,
 * writes it again, and the effect that reconciles the order never settles.
 */
function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const key of keys) {
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(key);
  }

  return deduped;
}

function normalizeWorkspaceOrderByProject(
  workspaceOrderByProject: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [projectViewKey, order] of Object.entries(workspaceOrderByProject ?? {})) {
    const scope = projectViewKey;
    if (!scope.trim()) continue;
    normalized[scope] = dedupeKeys(order);
  }
  return normalized;
}

function extractWorkspaceOrderScope(scopeKey: string): SidebarWorkspaceOrderScope | null {
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) return null;
  const serverId = scopeKey.slice(0, separatorIndex).trim();
  const projectViewKey = scopeKey.slice(separatorIndex + 2).trim();
  if (!serverId || !projectViewKey) return null;
  return { serverId, projectViewKey };
}

function normalizeLegacyWorkspaceKey(serverId: string, rawWorkspaceKey: string): string | null {
  const workspaceKey = rawWorkspaceKey.trim();
  if (!workspaceKey) return null;
  const serverPrefix = `${serverId}:`;
  return workspaceKey.startsWith(serverPrefix) ? workspaceKey : `${serverPrefix}${workspaceKey}`;
}

function migrateModernSidebarOrderState(state: SidebarOrderPersistedState) {
  return {
    projectOrder: state.projectOrder ?? [],
    pinnedWorkspaceOrder: state.pinnedWorkspaceOrder ?? [],
    superpinnedWorkspaceOrder: state.superpinnedWorkspaceOrder ?? [],
    pinnedWorkspaceTree: state.pinnedWorkspaceTree ?? {},
    pinnedWorkspaceSortMode: state.pinnedWorkspaceSortMode ?? "manual",
    workspaceOrderByProject: state.workspaceOrderByProject ?? {},
    workspaceSortModeByProject: state.workspaceSortModeByProject ?? {},
  };
}

export function migrateSidebarOrderState(
  persistedState: unknown,
  version = 0,
): {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  superpinnedWorkspaceOrder: string[];
  pinnedWorkspaceTree: Record<string, PinnedWorkspaceTreePlacement>;
  pinnedWorkspaceSortMode: PinnedWorkspaceSortMode;
  workspaceOrderByProject: Record<string, string[]>;
  workspaceSortModeByProject: Record<string, SidebarWorkspaceSortMode>;
} {
  const result = SidebarOrderPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      superpinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: {},
      pinnedWorkspaceSortMode: "manual",
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
    };
  }
  const state: SidebarOrderPersistedState = result.data;

  // v2 already stores exact view keys, including directory names ending in a
  // space. Adding the pin tree must not rerun legacy trimming or merge scopes.
  if (version >= 2) {
    return migrateModernSidebarOrderState(state);
  }

  const projectOrder = normalizeKeys(state.projectOrder ?? []);
  const seenProjects = new Set(projectOrder);
  for (const keys of Object.values(state.projectOrderByServerId ?? {})) {
    for (const key of normalizeKeys(keys)) {
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projectOrder.push(key);
    }
  }

  const workspaceOrderByProject = normalizeWorkspaceOrderByProject(state.workspaceOrderByProject);
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject ?? {})) {
    const scope = extractWorkspaceOrderScope(scopeKey);
    if (!scope) continue;
    const existing = workspaceOrderByProject[scope.projectViewKey] ?? [];
    const merged = [...existing];
    const seen = new Set(merged);
    for (const key of order) {
      const workspaceKey = normalizeLegacyWorkspaceKey(scope.serverId, key);
      if (!workspaceKey || seen.has(workspaceKey)) continue;
      seen.add(workspaceKey);
      merged.push(workspaceKey);
    }
    workspaceOrderByProject[scope.projectViewKey] = merged;
  }

  return {
    ...migrateModernSidebarOrderState(state),
    projectOrder,
    pinnedWorkspaceOrder: normalizeKeys(state.pinnedWorkspaceOrder ?? []),
    superpinnedWorkspaceOrder: normalizeKeys(state.superpinnedWorkspaceOrder ?? []),
    workspaceOrderByProject,
  };
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      superpinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: {},
      setPinnedWorkspaceTree: async (tree, rootOrder) => {
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
      setSuperpinnedWorkspaceOrder: (keys) => set({ superpinnedWorkspaceOrder: dedupeKeys(keys) }),
      pinnedWorkspaceSortMode: "manual",
      setPinnedWorkspaceSortMode: (mode) => set({ pinnedWorkspaceSortMode: mode }),
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
      setWorkspaceSortMode: (projectViewKey, mode) => {
        if (!projectViewKey.trim()) return;
        set((state) => ({
          workspaceSortModeByProject: {
            ...state.workspaceSortModeByProject,
            [projectViewKey]: mode,
          },
        }));
      },
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys) => {
        set({ projectOrder: dedupeKeys(keys) });
      },
      getPinnedWorkspaceOrder: () => get().pinnedWorkspaceOrder,
      setPinnedWorkspaceOrder: (keys) => {
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
      storage: createValidatedPersistStorage(AsyncStorage, SidebarOrderPersistedStateSchema),
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
    },
  ),
);
