import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  serializeMainHostAllocation,
  type MainHostChoice,
} from "@getpaseo/protocol/fleet/main-host";
import { useFetchQueries } from "@/data/query";
import {
  getHostRuntimeStore,
  useHosts,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";

type MainHostRead = Awaited<ReturnType<DaemonClient["getMainHost"]>>;
export interface MainHostView {
  serverId: string;
  label: string;
  connected: boolean;
  checking: boolean;
  supported: boolean;
  canManage: boolean;
  read: MainHostRead | undefined;
  error: Error | null;
}

export type MainHostResolution =
  | { kind: "loading" | "unavailable" | "unset" | "disagree"; mainHost: null }
  | { kind: "held"; mainHost: null; choice: MainHostChoice }
  | { kind: "ready"; mainHost: string | null; choice: MainHostChoice };

export function isMainHostReadPending(views: readonly MainHostView[]): boolean {
  // Connection retries remain visible in Main's UI without blocking startup navigation.
  return views.some((view) => view.connected && view.supported && !view.read && !view.error);
}

export function resolveMainHost(views: readonly MainHostView[]): MainHostResolution {
  const connected = views.filter((view) => view.connected && view.supported);
  if (views.length > 0 && connected.length === 0)
    return {
      kind: views.some((view) => view.checking) ? "loading" : "unavailable",
      mainHost: null,
    };
  if (isMainHostReadPending(views)) return { kind: "loading", mainHost: null };
  if (connected.some((view) => view.error)) return { kind: "unavailable", mainHost: null };
  const choices = connected.flatMap((view) =>
    view.read?.state.choice ? [view.read.state.choice] : [],
  );
  if (
    choices.some((choice) =>
      choices.some(
        (other) =>
          other.generation === choice.generation && other.allocationId !== choice.allocationId,
      ),
    )
  )
    return { kind: "disagree", mainHost: null };
  const held = connected.find((view) => view.read?.state.held && view.read.state.choice);
  if (held?.read?.state.choice)
    return { kind: "held", mainHost: null, choice: held.read.state.choice };
  if (choices.length === 0) return { kind: "unset", mainHost: null };
  const choice = choices[0];
  if (
    choices.length !== connected.length ||
    choices.some((entry) => entry.allocationId !== choice.allocationId)
  )
    return { kind: "disagree", mainHost: null };
  return { kind: "ready", mainHost: choice.mainHost, choice };
}

interface MainHostAction {
  kind: "set" | "deliver" | "undo";
  serverId: string;
  requestId: string;
  choice?: MainHostChoice;
}

export function shouldClearMainHostError(
  error: Error | null,
  action: MainHostAction | undefined,
  resolution: MainHostResolution,
): boolean {
  // A lost acknowledgement is resolved by the durable receipt, never by hiding a refusal.
  if (!(error instanceof DaemonConnectionError) || !action || resolution.kind !== "ready")
    return false;
  const choice = resolution.choice;
  if (action.kind === "deliver")
    return (
      !!action.choice &&
      choice.receipt === action.choice.receipt &&
      serializeMainHostAllocation(choice) === serializeMainHostAllocation(action.choice)
    );
  if (choice.requestId !== action.requestId || choice.allocatorServerId !== action.serverId)
    return false;
  return action.kind === "set"
    ? choice.mainHost === action.serverId
    : !!action.choice &&
        choice.mainHost === action.choice.previousMainHost &&
        choice.undoOf === action.choice.allocationId;
}

interface MainHostContextValue {
  views: MainHostView[];
  resolution: MainHostResolution;
  busy: boolean;
  error: Error | null;
  run: (action: Omit<MainHostAction, "requestId">) => void;
  retry: () => void;
  refresh: () => void;
}

const MainHostContext = createContext<MainHostContextValue | null>(null);

export function MainHostProvider({ children }: { children: ReactNode }) {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const inputs = hosts.map((host) => {
    const client = runtime.getClient(host.serverId);
    const info = client?.getLastServerInfoMessage();
    return {
      serverId: host.serverId,
      label: host.label,
      connected: statuses.get(host.serverId) === "online",
      checking: statuses.get(host.serverId) === "connecting",
      supported: info?.features?.mainHost === true,
      canManage: info?.permissions?.includes("daemon.manage") === true,
    };
  });
  const queries = useFetchQueries<MainHostRead>(
    inputs.map((host) => ({
      queryKey: ["main-host", host.serverId],
      queryFn: async () => {
        const client = runtime.getClient(host.serverId);
        if (!client) throw new Error("Host is not connected.");
        return client.getMainHost();
      },
      enabled: host.connected && host.supported,
      refetchInterval: 2_000,
      dataShape: "value",
      staleTimeMs: 500,
    })),
  );
  const views = inputs.map((host, index) => ({
    ...host,
    checking: host.checking && !queries[index]?.data && !queries[index]?.error,
    read: queries[index]?.data,
    error: queries[index]?.error ?? null,
  }));
  const resolution = resolveMainHost(views);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["main-host"] });
  };
  const mutation = useMutation({
    mutationFn: async (action: MainHostAction) => {
      const connected = inputs.filter((host) => host.connected && host.supported);
      const reads = await Promise.all(
        connected.map(async (host) => {
          const client = runtime.getClient(host.serverId);
          if (!client) throw new Error("Host disconnected. Retry host settings.");
          const read = await client.getMainHost();
          return { host, client, read };
        }),
      );
      const selected = reads.find((entry) => entry.host.serverId === action.serverId);
      const allocator = selected ?? (action.kind === "deliver" ? reads[0] : undefined);
      if (!allocator) throw new Error("The selected host must be connected and support Main host.");
      if (!allocator.host.canManage)
        throw new Error("Manage access is required to change Main host.");
      const choice =
        action.kind === "deliver" ? action.choice : await allocateChoice(action, allocator, reads);
      if (!choice) throw new Error("Main host allocation is unavailable. Retry host settings.");
      const source = await readAllocator(choice, reads);
      for (const receiver of reads) {
        const before = await receiver.client.getMainHost();
        await receiver.client.applyMainHost({
          choice,
          expectedLocalGeneration: before.state.choice?.generation ?? 0,
          confirmation: { allocationId: choice.allocationId },
          allocatorPublicKey: source?.allocator.publicKey,
          requestId: `${action.requestId}:deliver:${receiver.host.serverId}`,
        });
      }
    },
    onSettled: refresh,
  });
  useEffect(() => {
    if (shouldClearMainHostError(mutation.error, mutation.variables, resolution)) mutation.reset();
  }, [mutation, resolution]);
  const reconciliationKey = views
    .map(
      (view) =>
        `${view.serverId}:${view.connected}:${view.read?.state.choice?.allocationId}:${view.read?.state.held}`,
    )
    .join("|");
  const lastAutomaticDelivery = useRef<string | null>(null);
  useEffect(() => {
    if (
      resolution.kind !== "disagree" ||
      mutation.isPending ||
      lastAutomaticDelivery.current === reconciliationKey
    )
      return;
    const connected = views.filter((view) => view.connected && view.supported);
    if (connected.some((view) => !view.read || view.read.state.held || !view.canManage)) return;
    const ordered = connected
      .flatMap((view) => (view.read?.state.choice ? [view.read.state.choice] : []))
      .sort((left, right) => right.generation - left.generation);
    const newest = ordered[0];
    if (
      !newest ||
      ordered.some(
        (choice) =>
          choice.generation === newest.generation && choice.allocationId !== newest.allocationId,
      )
    )
      return;
    lastAutomaticDelivery.current = reconciliationKey;
    mutation.mutate({
      kind: "deliver",
      serverId: newest.allocatorServerId,
      choice: newest,
      requestId: `reconnect:${newest.allocationId}:${reconciliationKey}`,
    });
  }, [reconciliationKey, views, resolution.kind, mutation]);
  const value: MainHostContextValue = {
    views,
    resolution,
    busy: mutation.isPending,
    error: mutation.error,
    run: (action) => mutation.mutate({ ...action, requestId: randomUUID() }),
    retry: () => {
      if (mutation.variables) mutation.mutate(mutation.variables);
      else refresh();
    },
    refresh,
  };
  return createElement(MainHostContext.Provider, { value }, children);
}

interface ConnectedMainHostRead {
  host: { serverId: string; canManage: boolean };
  client: DaemonClient;
  read: MainHostRead;
}

async function allocateChoice(
  action: MainHostAction,
  allocator: ConnectedMainHostRead,
  reads: readonly ConnectedMainHostRead[],
): Promise<MainHostChoice | undefined> {
  let current = allocator.read.state.choice;
  const highest = reads.reduce<MainHostChoice | null>((selected, entry) => {
    const candidate = entry.read.state.choice;
    if (candidate && candidate.generation > (selected?.generation ?? 0)) return candidate;
    return selected;
  }, null);
  verifyMainHostUndo(
    action,
    current,
    reads.flatMap((entry) => (entry.read.state.choice ? [entry.read.state.choice] : [])),
  );
  if (highest && highest.generation > (current?.generation ?? 0)) {
    const source = await readAllocator(highest, reads);
    const caughtUp = await allocator.client.applyMainHost({
      choice: highest,
      expectedLocalGeneration: current?.generation ?? 0,
      confirmation: null,
      allocatorPublicKey: source?.allocator.publicKey,
      requestId: `${action.requestId}:catchup`,
    });
    current = caughtUp.state.choice;
  }
  const mainHost =
    action.kind === "undo" ? (action.choice?.previousMainHost ?? null) : action.serverId;
  const allocation = await allocator.client.setMainHost({
    mainHost,
    expectedGeneration: current?.generation ?? 0,
    requestId: action.requestId,
  });
  return allocation.state.choice ?? undefined;
}

export function verifyMainHostUndo(
  action: MainHostAction,
  current: MainHostChoice | null,
  choices: readonly MainHostChoice[],
): void {
  if (action.kind !== "undo") return;
  const original = action.choice;
  // Retry reuses the request ID. The allocator may already have durably committed
  // this Undo before its reply or a subsequent delivery acknowledgement was lost.
  const replay =
    original &&
    current?.requestId === action.requestId &&
    current.allocatorServerId === action.serverId &&
    current.undoOf === original.allocationId &&
    current.mainHost === original.previousMainHost &&
    current.generation === original.generation + 1
      ? current
      : null;
  if (
    !original ||
    (current?.allocationId !== original.allocationId && !replay) ||
    choices.some(
      (choice) =>
        choice.generation >= original.generation &&
        choice.allocationId !== original.allocationId &&
        choice.allocationId !== replay?.allocationId,
    )
  ) {
    throw new Error("Main host changed after this Undo was shown. Retry host settings.");
  }
}

async function readAllocator(
  choice: MainHostChoice,
  reads: readonly { host: { serverId: string }; client: DaemonClient; read: MainHostRead }[],
): Promise<MainHostRead | null> {
  const source = reads.find((entry) => entry.host.serverId === choice.allocatorServerId);
  if (!source) return null;
  const read = await source.client.getMainHost();
  if (read.allocator.serverId !== choice.allocatorServerId)
    throw new Error("Allocator identity does not match the connected host.");
  return read;
}

export function useMainHost(): MainHostContextValue {
  const value = useContext(MainHostContext);
  if (!value) throw new Error("MainHostProvider is required");
  return value;
}
