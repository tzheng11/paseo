import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { hydrateStreamState, streamTimelineItemIdentity, type StreamItem } from "@/types/stream";

export type TimelineHistoryPage = Awaited<ReturnType<DaemonClient["fetchAgentTimelineHistory"]>>;

export interface LoadedHistoryMiddle {
  entries: NonNullable<TimelineHistoryPage["entries"]>;
  nextIndex: number;
  coveredBytes: number;
  oversized: NonNullable<TimelineHistoryPage["oversized"]>;
}

function hydrate(entries: NonNullable<TimelineHistoryPage["entries"]>): StreamItem[] {
  return hydrateStreamState(
    entries.map((entry) => ({
      event: {
        type: "timeline",
        provider: entry.provider,
        item: entry.item,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      },
      timestamp: new Date(entry.timestamp ?? 0),
    })),
    { source: "canonical" },
  );
}

function identity(item: StreamItem): string | null {
  if (item.kind === "assistant_message") return `assistant:${item.messageId ?? item.id}`;
  if (item.kind === "user_message")
    return `user:${item.messageId ?? item.clientMessageId ?? item.id}`;
  return streamTimelineItemIdentity(item);
}

/** Provider positions are independent of live delivery cursors. Never invent stream sequences. */
export function buildBoundedHistoryPresentation(input: {
  snapshot: TimelineHistoryPage;
  middle: LoadedHistoryMiddle | null;
  live: StreamItem[];
}): StreamItem[] {
  const { snapshot, middle, live } = input;
  if (!snapshot.gap) return live;
  const head = hydrate(snapshot.head ?? []),
    tail = hydrate(snapshot.tail ?? []);
  const mid = hydrate(middle?.entries ?? []);
  const next = middle?.nextIndex ?? snapshot.gap.startIndex;
  const count = Math.max(0, snapshot.gap.endIndex + 1 - next);
  const gaps: StreamItem[] = count
    ? [
        {
          kind: "notification",
          sourceType: "notification",
          id: `history-gap:${snapshot.epoch}:${next}`,
          timestamp: new Date(0),
          level: "info",
          message: "Earlier history is available on demand",
          historyGap: {
            cursor: next,
            count,
            bytes: Math.max(0, snapshot.gap.bytes - (middle?.coveredBytes ?? 0)),
          },
        },
      ]
    : [];
  const omissions: StreamItem[] = (middle?.oversized ?? []).map((entry) => ({
    kind: "notification",
    sourceType: "notification",
    id: `history-oversized:${snapshot.epoch}:${entry.index}`,
    timestamp: new Date(0),
    level: "info",
    message: `History item exceeds the page limit (${entry.bytes.toLocaleString()} bytes).`,
  }));
  const history = [...head, ...mid, ...omissions, ...gaps, ...tail];
  return mergeLiveHistory(
    history,
    live,
    snapshot.liveAfterSeq ?? (snapshot.head?.length ?? 0) + (snapshot.tail?.length ?? 0),
  );
}

function mergeLiveHistory(
  history: StreamItem[],
  live: StreamItem[],
  boundary: number,
): StreamItem[] {
  const identities = new Map<string, number>();
  for (let index = 0; index < history.length; index++) {
    const key = identity(history[index]);
    if (key) identities.set(key, index);
  }
  for (const item of live) {
    const key = identity(item);
    const index = key ? identities.get(key) : undefined;
    if (index !== undefined) {
      history[index] = item;
      continue;
    }
    if (!item.timelineCursor || item.timelineCursor.seq > boundary) history.push(item);
  }
  return history;
}
