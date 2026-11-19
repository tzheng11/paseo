import { z } from "zod";
export const UNGROUPED_WORKSPACE_SORT_KEY = "section:workspaces";
import type { WorkspaceNavigationPreferences } from "./workspace-layout.js";

type SidebarWorkspaceSortMode = WorkspaceNavigationPreferences["pinnedWorkspaceSortMode"];
type PinnedWorkspaceSortMode = SidebarWorkspaceSortMode;
export interface PinnedWorkspaceTreePlacement {
  parentWorkspaceKey: string | null;
  siblingOrder: number;
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
export const PinnedWorkspaceTreeSchema = z.record(
  z.string(),
  z.strictObject({
    parentWorkspaceKey: z.string().nullable(),
    siblingOrder: z.number().finite(),
  }),
);
export const LegacySidebarOrderStateSchema = z.strictObject({
  projectOrder: z.array(z.string()).optional(),
  pinnedWorkspaceOrder: z.array(z.string()).optional(),
  superpinnedWorkspaceOrder: z.array(z.string()).optional(),
  pinnedWorkspaceTree: PinnedWorkspaceTreeSchema.optional(),
  pinnedWorkspaceSortMode: WorkspaceSortModeSchema.optional(),
  workspaceSortModeByProject: z.record(z.string(), WorkspaceSortModeSchema).optional(),
  workspaceOrderByProject: StringArrayRecordSchema.optional(),
  projectOrderByServerId: StringArrayRecordSchema.optional(),
  workspaceOrderByServerAndProject: StringArrayRecordSchema.optional(),
});

export const SidebarOrderPersistedStateSchema = LegacySidebarOrderStateSchema.extend({
  pinnedWorkspaceTree: PinnedWorkspaceTreeSchema.catch({}).optional(),
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
export function dedupeKeys(keys: string[]): string[] {
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
