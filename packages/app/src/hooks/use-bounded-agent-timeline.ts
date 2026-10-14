import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";
import {
  buildBoundedHistoryPresentation,
  type LoadedHistoryMiddle,
  type TimelineHistoryPage,
} from "@/agent-stream/bounded-history";

interface LoadedHistory {
  agentId: string;
  epoch: string;
  snapshot: TimelineHistoryPage;
  middle: LoadedHistoryMiddle | null;
}

export function useBoundedAgentTimeline(input: {
  client: DaemonClient | null;
  agentId: string;
  epoch: string | null;
  providerSupported: boolean;
  enabled: boolean;
  active: boolean;
  customPagination: boolean;
  live: StreamItem[];
}) {
  const { client, agentId, epoch, enabled, providerSupported, active, customPagination, live } =
    input;
  const generation = useRef(0);
  const [loaded, setLoaded] = useState<LoadedHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    generation.current++;
    setLoaded(null);
    setError(null);
    setLoading(false);
    if (!enabled || !providerSupported || !active || customPagination || !client || !epoch) return;
    let canceled = false;
    void client.fetchAgentTimelineHistory({ agentId, operation: "windows", epoch }).then(
      (snapshot) => {
        if (!canceled) setLoaded({ agentId, epoch: snapshot.epoch, snapshot, middle: null });
        return undefined;
      },
      (failure: unknown) => {
        if (!canceled)
          setError(failure instanceof Error ? failure.message : "History loading failed");
        return undefined;
      },
    );
    return () => {
      canceled = true;
    };
  }, [agentId, client, enabled, providerSupported, active, customPagination, epoch]);
  const current = loaded?.agentId === agentId && loaded.epoch === epoch ? loaded : null;
  const loadMiddle = useCallback(async () => {
    if (!client || !current?.snapshot.gap || loading) return;
    const cursor = current.middle?.nextIndex ?? current.snapshot.gap.startIndex;
    const folded = foldTarget(current.middle, cursor);
    if (folded) {
      setLoaded({ ...current, middle: folded });
      return;
    }
    const events = Math.min(
      128,
      Math.min(current.middle?.target?.startIndex ?? Infinity, current.snapshot.gap.endIndex + 1) -
        cursor,
    );
    if (events < 1) return;
    const currentGeneration = generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await client.fetchAgentTimelineHistory({
        agentId,
        operation: "page",
        epoch: current.epoch,
        cursor,
        direction: "after",
        limit: { events, bytes: 256 * 1024 },
      });
      const next = page.nextCursor ?? current.snapshot.totalEvents ?? cursor;
      if (next <= cursor) throw new Error("History page did not advance");
      setLoaded((state) =>
        state === current
          ? {
              ...state,
              middle: {
                entries: [...(state.middle?.entries ?? []), ...(page.entries ?? [])],
                nextIndex: next,
                coveredBytes: (state.middle?.coveredBytes ?? 0) + (page.coveredBytes ?? 0),
                oversized: [...(state.middle?.oversized ?? []), ...(page.oversized ?? [])],
                target: state.middle?.target,
              },
            }
          : state,
      );
    } catch (failure) {
      if (generation.current === currentGeneration)
        setError(failure instanceof Error ? failure.message : "History loading failed");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [agentId, client, current, loading]);
  const loadAt = useCallback(
    async (index: number) => {
      if (!client || !current) throw new Error("History windows are not ready");
      const cursor = Math.max(
        index,
        current.middle?.nextIndex ?? current.snapshot.gap?.startIndex ?? 0,
      );
      const currentGeneration = generation.current;
      const page = await client.fetchAgentTimelineHistory({
        agentId,
        operation: "page",
        epoch: current.epoch,
        cursor,
        direction: "after",
        limit: {
          events:
            cursor <= (current.snapshot.gap?.endIndex ?? -1)
              ? Math.min(32, current.snapshot.gap!.endIndex + 1 - cursor)
              : 32,
          bytes: 256 * 1024,
        },
      });
      if (!page.entries?.some((entry) => entry.index === index))
        throw new Error("History item exceeds the display page limit");
      if (generation.current !== currentGeneration)
        throw new Error("History changed while loading its page");
      const end = page.nextCursor ?? cursor + (page.coveredCount ?? 0);
      setLoaded((state) =>
        state === current
          ? {
              ...state,
              middle: {
                entries: state.middle?.entries ?? [],
                nextIndex: state.middle?.nextIndex ?? state.snapshot.gap?.startIndex ?? 0,
                coveredBytes: state.middle?.coveredBytes ?? 0,
                oversized: state.middle?.oversized ?? [],
                target: {
                  entries: page.entries ?? [],
                  startIndex: cursor,
                  endIndex: end,
                  coveredBytes: page.coveredBytes ?? 0,
                  oversized: page.oversized ?? [],
                },
              },
            }
          : state,
      );
    },
    [agentId, client, current],
  );
  const items = useMemo(
    () =>
      current
        ? buildBoundedHistoryPresentation({
            snapshot: current.snapshot,
            middle: current.middle,
            live,
          })
        : live,
    [current, live],
  );
  return { items, loading, error, loadMiddle, loadAt: current?.snapshot.gap ? loadAt : undefined };
}

export function supportsBoundedAgentHistory(
  capabilities: AgentCapabilityFlags | undefined,
): boolean {
  return capabilities?.supportsBoundedHistory === true;
}

function foldTarget(
  middle: LoadedHistoryMiddle | null,
  cursor: number,
): LoadedHistoryMiddle | null {
  if (!middle?.target || middle.target.startIndex !== cursor) return null;
  const target = middle.target;
  return {
    entries: [...middle.entries, ...target.entries],
    nextIndex: target.endIndex,
    coveredBytes: middle.coveredBytes + target.coveredBytes,
    oversized: [...middle.oversized, ...target.oversized],
  };
}
