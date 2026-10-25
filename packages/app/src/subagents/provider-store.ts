import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import {
  processTimelineResponse,
  processAgentStreamEvent,
  type TimelineCursor,
} from "@/timeline/session-stream-reducers";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  hasOlder: boolean;
  cursor: TimelineCursor | undefined;
  needsRefresh: boolean;
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  /** Active list consumers; cached children outlive their last consumer. */
  trackedParents: Map<string, number>;
  trackParent(serverId: string, parentAgentId: string): void;
  untrackParent(serverId: string, parentAgentId: string): void;
  hideFromTrack(serverId: string, parentAgentId: string, subagentIds: readonly string[]): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
  ): void;
  applyUpdate(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.update" }
    >["payload"],
  ): void;
  replaceTimeline(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.timeline.get.response" }
    >["payload"],
  ): void;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

type ProviderSubagentListClient = Pick<DaemonClient, "listProviderSubagents">;

interface PendingProviderSubagentList {
  promise: Promise<void>;
  token: object;
  isCurrent: () => boolean;
}

const pendingListRequests = new WeakMap<
  ProviderSubagentListClient,
  Map<string, PendingProviderSubagentList>
>();
const latestListRequests = new Map<string, object>();

export function refreshProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
  options: { isCurrent?: () => boolean } = {},
): Promise<void> {
  if (options.isCurrent?.() === false) return Promise.resolve();
  const requestKey = `${serverId}\0${parentAgentId}`;
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) {
    if (latestListRequests.get(requestKey) === pending.token && pending.isCurrent()) {
      return pending.promise;
    }
    return pending.promise
      .catch(() => undefined)
      .then(() => refreshProviderSubagents(client, serverId, parentAgentId, options));
  }

  const token = {};
  latestListRequests.set(requestKey, token);
  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      if (latestListRequests.get(requestKey) === token && options.isCurrent?.() !== false) {
        useProviderSubagentStore.getState().replaceList(serverId, parentAgentId, payload.subagents);
      }
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
      if (latestListRequests.get(requestKey) === token) latestListRequests.delete(requestKey);
    });
  clientRequests.set(requestKey, {
    promise: request,
    token,
    isCurrent: () => options.isCurrent?.() !== false,
  });
  return request;
}

/** Own list recovery only while a parent or one of its child panes is mounted. */
export function observeProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
): () => void {
  useProviderSubagentStore.getState().trackParent(serverId, parentAgentId);
  void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    useProviderSubagentStore.getState().untrackParent(serverId, parentAgentId);
  };
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

const MAX_PROVIDER_SUBAGENT_RESYNC_REQUESTS = 4;

interface ProviderSubagentResync {
  parentAgentIds: string[];
  nextIndex: number;
  inflight: number;
  stopped: boolean;
  signal?: AbortSignal;
  cancel: () => void;
  complete: () => void;
}

interface ProviderSubagentResyncQueue {
  inflight: number;
  current: ProviderSubagentResync | null;
}

const resyncQueues = new WeakMap<
  ProviderSubagentListClient,
  Map<string, ProviderSubagentResyncQueue>
>();

function finishProviderSubagentResync(
  queue: ProviderSubagentResyncQueue,
  resync: ProviderSubagentResync,
): void {
  if (resync.nextIndex < resync.parentAgentIds.length || resync.inflight > 0) return;
  resync.signal?.removeEventListener("abort", resync.cancel);
  if (queue.current === resync) queue.current = null;
  resync.complete();
}

function stopProviderSubagentResync(
  queue: ProviderSubagentResyncQueue,
  resync: ProviderSubagentResync,
): void {
  resync.stopped = true;
  resync.nextIndex = resync.parentAgentIds.length;
  if (queue.current === resync) queue.current = null;
  finishProviderSubagentResync(queue, resync);
}

function ownsProviderSubagentResync(
  queue: ProviderSubagentResyncQueue,
  resync: ProviderSubagentResync,
  serverId: string,
  parentAgentId: string,
): boolean {
  return (
    queue.current === resync &&
    !resync.stopped &&
    !resync.signal?.aborted &&
    useProviderSubagentStore.getState().trackedParents.has(parentPrefix(serverId, parentAgentId))
  );
}

function drainProviderSubagentResync(
  client: ProviderSubagentListClient,
  serverId: string,
  queue: ProviderSubagentResyncQueue,
): void {
  const resync = queue.current;
  if (!resync) return;
  while (
    queue.inflight < MAX_PROVIDER_SUBAGENT_RESYNC_REQUESTS &&
    resync.nextIndex < resync.parentAgentIds.length
  ) {
    const parentAgentId = resync.parentAgentIds[resync.nextIndex++];
    const isCurrent = () => ownsProviderSubagentResync(queue, resync, serverId, parentAgentId);
    if (!isCurrent()) continue;
    queue.inflight++;
    resync.inflight++;
    void (async () => {
      // A request started before this feed snapshot cannot supply its missing interval.
      // Wait for it without cancelling another consumer's shared server load.
      await pendingListRequests
        .get(client)
        ?.get(`${serverId}\0${parentAgentId}`)
        ?.promise.catch(() => undefined);
      if (isCurrent()) {
        await refreshProviderSubagents(client, serverId, parentAgentId, { isCurrent });
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        queue.inflight--;
        resync.inflight--;
        finishProviderSubagentResync(queue, resync);
        drainProviderSubagentResync(client, serverId, queue);
      });
  }
  finishProviderSubagentResync(queue, resync);
}

/** Recover only owned parents after a feed snapshot, sharing four slots across replaced snapshots. */
export function resyncProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) return Promise.resolve();
  let clientQueues = resyncQueues.get(client);
  if (!clientQueues) {
    clientQueues = new Map();
    resyncQueues.set(client, clientQueues);
  }
  let queue = clientQueues.get(serverId);
  if (!queue) {
    queue = { inflight: 0, current: null };
    clientQueues.set(serverId, queue);
  }
  if (queue.current) stopProviderSubagentResync(queue, queue.current);
  const serverPrefix = `${serverId}\0`;
  const parentAgentIds = [...useProviderSubagentStore.getState().trackedParents.keys()]
    .filter((key) => key.startsWith(serverPrefix))
    .map((key) => key.slice(serverPrefix.length, -1));
  let complete = () => {};
  const result = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const resync: ProviderSubagentResync = {
    parentAgentIds,
    nextIndex: 0,
    inflight: 0,
    stopped: false,
    signal: options.signal,
    cancel: () => stopProviderSubagentResync(queue, resync),
    complete,
  };
  queue.current = resync;
  resync.signal?.addEventListener("abort", resync.cancel, { once: true });
  drainProviderSubagentResync(client, serverId, queue);
  return result;
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  cursor: undefined,
  needsRefresh: false,
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") {
    return null;
  }
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function settleTimeline(
  timeline: ProviderSubagentTimelineState,
  descriptor?: ProviderSubagentDescriptorPayload,
): ProviderSubagentTimelineState {
  const event = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (!event || !descriptor) return timeline;
  return {
    ...timeline,
    ...applyStreamEvent({
      tail: timeline.tail,
      head: timeline.head,
      event,
      timestamp: new Date(descriptor.updatedAt),
    }),
  };
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  trackedParents: new Map(),
  trackParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const trackedParents = new Map(state.trackedParents);
      trackedParents.set(prefix, (trackedParents.get(prefix) ?? 0) + 1);
      return { trackedParents };
    });
  },
  untrackParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const count = state.trackedParents.get(prefix);
      if (!count) return state;
      const trackedParents = new Map(state.trackedParents);
      if (count === 1) trackedParents.delete(prefix);
      else trackedParents.set(prefix, count - 1);
      return { trackedParents };
    });
  },
  hideFromTrack(serverId, parentAgentId, subagentIds) {
    set((state) => {
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagentId of subagentIds) {
        const key = providerSubagentKey(serverId, parentAgentId, subagentId);
        if (state.descriptors.get(key)?.status !== "running") hiddenFromTrack.add(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        descriptors.set(key, subagent);
        if (subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(key, settleTimeline(current, subagent));
        }
      }
      return { descriptors, timelines, hiddenFromTrack };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        const descriptors = new Map(state.descriptors);
        const hiddenFromTrack = new Set(state.hiddenFromTrack);
        const previous = descriptors.get(key);
        descriptors.set(key, payload.subagent);
        if (payload.subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current && previous?.status !== payload.subagent.status) {
          timelines = new Map(state.timelines);
          timelines.set(key, settleTimeline(current, payload.subagent));
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      if (existing?.epoch && existing.epoch !== payload.epoch) {
        return state;
      }
      const current = existing ?? EMPTY_TIMELINE;
      if (payload.seq <= current.lastSeq) {
        return state;
      }
      const next = processAgentStreamEvent({
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        hasAuthoritativeBaseline: current.cursor !== undefined,
        event: { type: "timeline", provider: payload.provider, item: payload.item },
        timestamp: new Date(payload.timestamp),
        seq: payload.seq,
        epoch: payload.epoch,
      });
      const timelines = new Map(state.timelines);
      timelines.set(
        key,
        settleTimeline(
          {
            tail: next.tail,
            head: next.head,
            epoch: payload.epoch,
            lastSeq: payload.seq,
            cursor: next.cursor ?? current.cursor,
            hasOlder: current.hasOlder,
            needsRefresh:
              current.needsRefresh || next.sideEffects.some((effect) => effect.type === "catch_up"),
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
  },
  replaceTimeline(serverId, payload) {
    const provider = payload.provider;
    if (!provider) {
      return;
    }
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      const current = existing ?? EMPTY_TIMELINE;
      // Normalize optional wire metadata at the child timeline boundary. Legacy
      // notices are complete singleton items; history always comes from a projected host.
      const entries = payload.rows.map((row) => ({
        ...row,
        provider,
        seqStart: row.seqStart ?? row.seq,
        seqEnd: row.seqEnd ?? row.seq,
      }));
      const result = processTimelineResponse({
        payload: {
          ...payload,
          agentId: payload.subagentId,
          projection: "projected",
          startCursor:
            payload.startCursor ??
            (entries.length ? { seq: Math.min(...entries.map((entry) => entry.seqStart)) } : null),
          endCursor:
            payload.endCursor ??
            (entries.length ? { seq: Math.max(...entries.map((entry) => entry.seqEnd)) } : null),
          entries,
        },
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        isInitializing: current.cursor === undefined,
        hasActiveInitDeferred: current.cursor === undefined,
        initRequestDirection: "tail",
        sendingClientMessageIds: [],
      });
      const timelines = new Map(state.timelines);
      timelines.set(
        key,
        settleTimeline(
          {
            tail: result.tail,
            head: result.head,
            epoch: payload.epoch,
            lastSeq:
              payload.reset || current.epoch !== payload.epoch
                ? (result.cursor?.endSeq ?? 0)
                : Math.max(current.lastSeq, result.cursor?.endSeq ?? 0),
            cursor: result.cursor ?? undefined,
            hasOlder:
              result.older === "unchanged" ? current.hasOlder : result.older === "available",
            needsRefresh:
              result.sideEffects.some((effect) => effect.type === "catch_up") &&
              (payload.hasNewer || current.lastSeq > (result.cursor?.endSeq ?? 0)),
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
  },
}));

/** Owns child history bootstrap and recovery while a pane observes the child. */
export function observeProviderSubagentTimeline({
  client,
  serverId,
  parentAgentId,
  subagentId,
  limit,
  reportError,
}: {
  client: Pick<DaemonClient, "fetchProviderSubagentTimeline">;
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  limit: number;
  reportError: (error: unknown) => void;
}): () => void {
  const key = providerSubagentKey(serverId, parentAgentId, subagentId);
  let active = true;
  let fetching = false;
  const refresh = async () => {
    if (!active || fetching) return;
    fetching = true;
    let succeeded = false;
    try {
      const payload = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        direction: "tail",
        limit,
      });
      if (active) useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
      succeeded = true;
    } catch (error) {
      // A later stream update or reopening the pane retries a disconnected read.
      if (!(error instanceof DaemonConnectionError)) throw error;
    } finally {
      fetching = false;
      if (
        succeeded &&
        active &&
        useProviderSubagentStore.getState().timelines.get(key)?.needsRefresh
      )
        requestRefresh();
    }
  };
  const requestRefresh = () => {
    void refresh().catch(reportError);
  };
  const unsubscribe = useProviderSubagentStore.subscribe((state) => {
    if (state.timelines.get(key)?.needsRefresh) requestRefresh();
  });
  requestRefresh();
  return () => {
    active = false;
    unsubscribe();
  };
}
