import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getWorkspaceDescendantKeys } from "./model";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useToast } from "@/contexts/toast-context";
import {
  resolveWorkspaceTreeDropResult,
  type WorkspaceDropPosition,
  type WorkspaceTreeDrop,
  type WorkspaceTreeDropRejection,
} from "./drop-target";

export interface WorkspaceTreeProviderProps {
  workspaces: readonly SidebarWorkspacePlacement[];
  allWorkspaces?: readonly SidebarWorkspacePlacement[];
  supportedServerIds: ReadonlyMap<string, boolean>;
  onMove: (drop: WorkspaceTreeDrop) => Promise<void>;
  children: ReactNode;
}
interface TreeDragController {
  workspaces: readonly SidebarWorkspacePlacement[];
  allWorkspaces: readonly SidebarWorkspacePlacement[];
  activeWorkspaceKey: string | null;
  activeSubtreeKeys: ReadonlySet<string>;
  drop: WorkspaceTreeDrop | null;
  rejection: WorkspaceTreeDropRejection | null;
  pending: boolean;
  enabled: (workspace: SidebarWorkspacePlacement) => boolean;
  start: (workspaceKey: string) => void;
  hover: (targetWorkspaceKey: string, position: WorkspaceDropPosition) => void;
  finish: () => void;
  cancel: () => void;
}
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ControllerContext = createContext<TreeDragController | null>(null);

export function WorkspaceTreeController({
  workspaces,
  allWorkspaces = workspaces,
  supportedServerIds,
  onMove,
  children,
}: WorkspaceTreeProviderProps) {
  const [activeWorkspaceKey, setActiveWorkspaceKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<WorkspaceTreeDrop | null>(null);
  const [rejection, setRejection] = useState<WorkspaceTreeDropRejection | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ drop: WorkspaceTreeDrop; message: string } | null>(null);
  const activeRef = useRef<string | null>(null);
  const dropRef = useRef<WorkspaceTreeDrop | null>(null);
  const rejectionRef = useRef<WorkspaceTreeDropRejection | null>(null);
  const pendingRef = useRef(false);
  const toast = useToast();
  const submit = useCallback(
    async (next: WorkspaceTreeDrop) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      setFailure(null);
      try {
        const current = resolveWorkspaceTreeDropResult({
          workspaces,
          allWorkspaces,
          workspaceKey: next.workspaceKey,
          targetWorkspaceKey: next.targetWorkspaceKey,
          position: next.position,
        });
        if (!current.drop)
          throw new Error(current.rejection?.message ?? "Workspace is no longer available");
        await onMove(current.drop);
        if (next.position === "inside") {
          useSidebarCollapsedSectionsStore
            .getState()
            .setWorkspaceCollapsed(next.targetWorkspaceKey, false);
        }
        const source = workspaces.find((workspace) => workspace.workspaceKey === next.workspaceKey);
        const target = workspaces.find(
          (workspace) => workspace.workspaceKey === next.targetWorkspaceKey,
        );
        toast.show(
          next.position === "inside"
            ? `Nested “${source?.name ?? "Workspace"}” under “${target?.name ?? "workspace"}”`
            : "Workspace order updated",
          { variant: "success", durationMs: 4000, testID: "workspace-tree-move-success" },
        );
      } catch (error) {
        setFailure({
          drop: next,
          message: error instanceof Error ? error.message : "Could not move workspace",
        });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [onMove, toast, workspaces, allWorkspaces],
  );
  const cancel = useCallback(() => {
    activeRef.current = null;
    dropRef.current = null;
    rejectionRef.current = null;
    setActiveWorkspaceKey(null);
    setDrop(null);
    setRejection(null);
  }, []);
  const start = useCallback((key: string) => {
    if (pendingRef.current) return;
    activeRef.current = key;
    setActiveWorkspaceKey(key);
    setFailure(null);
  }, []);
  const hover = useCallback(
    (targetWorkspaceKey: string, position: WorkspaceDropPosition) => {
      const source = activeRef.current;
      const result = source
        ? resolveWorkspaceTreeDropResult({
            workspaces,
            allWorkspaces,
            workspaceKey: source,
            targetWorkspaceKey,
            position,
          })
        : { drop: null, rejection: null };
      const next = result.drop;
      dropRef.current = next;
      rejectionRef.current = result.rejection;
      setDrop((previous) =>
        previous?.targetWorkspaceKey === next?.targetWorkspaceKey &&
        previous?.position === next?.position
          ? previous
          : next,
      );
      setRejection((previous) =>
        previous?.targetWorkspaceKey === result.rejection?.targetWorkspaceKey &&
        previous?.message === result.rejection?.message
          ? previous
          : result.rejection,
      );
    },
    [allWorkspaces, workspaces],
  );
  const finish = useCallback(() => {
    const next = dropRef.current;
    const blocked = rejectionRef.current;
    cancel();
    if (next) void submit(next);
    else if (blocked)
      toast.show(blocked.message, {
        variant: "warning",
        durationMs: 6000,
        testID: "workspace-tree-move-blocked",
      });
  }, [cancel, submit, toast]);
  useEffect(() => {
    if (drop?.position !== "inside") return;
    const timer = setTimeout(() => {
      useSidebarCollapsedSectionsStore
        .getState()
        .setWorkspaceCollapsed(drop.targetWorkspaceKey, false);
    }, 650);
    return () => clearTimeout(timer);
  }, [drop?.position, drop?.targetWorkspaceKey]);
  const enabled = useCallback(
    (workspace: SidebarWorkspacePlacement) =>
      (workspace.sidebarSection !== undefined ||
        supportedServerIds.get(workspace.serverId) === true) &&
      !pending,
    [pending, supportedServerIds],
  );
  const activeSubtreeKeys = useMemo(
    () =>
      activeWorkspaceKey
        ? new Set([
            activeWorkspaceKey,
            ...getWorkspaceDescendantKeys(allWorkspaces, activeWorkspaceKey),
          ])
        : new Set<string>(),
    [activeWorkspaceKey, allWorkspaces],
  );
  const value = useMemo(
    () => ({
      workspaces,
      allWorkspaces,
      activeWorkspaceKey,
      activeSubtreeKeys,
      drop,
      rejection,
      pending,
      enabled,
      start,
      hover,
      finish,
      cancel,
    }),
    [
      workspaces,
      allWorkspaces,
      activeWorkspaceKey,
      activeSubtreeKeys,
      drop,
      rejection,
      pending,
      enabled,
      start,
      hover,
      finish,
      cancel,
    ],
  );
  const retry = useCallback(() => {
    if (failure) void submit(failure.drop);
  }, [failure, submit]);
  const dismiss = useCallback(() => setFailure(null), []);
  return (
    <ControllerContext.Provider value={value}>
      {pending ? (
        <View
          style={styles.feedback}
          accessibilityRole="progressbar"
          testID="workspace-tree-move-pending"
        >
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.feedbackText}>Moving workspace...</Text>
        </View>
      ) : null}
      {failure ? (
        <View style={styles.feedback} accessibilityRole="alert" testID="workspace-tree-move-error">
          <Text style={styles.errorText}>{failure.message}</Text>
          <Button size="xs" variant="ghost" onPress={retry}>
            Retry
          </Button>
          <Button size="xs" variant="ghost" onPress={dismiss}>
            Dismiss
          </Button>
        </View>
      ) : null}
      {children}
    </ControllerContext.Provider>
  );
}
export function useWorkspaceTreeDrag(): TreeDragController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("WorkspaceTreeProvider is required");
  return controller;
}
const styles = StyleSheet.create((theme) => ({
  feedback: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
  },
  feedbackText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, flex: 1 },
}));
