import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { hydrateStreamState, streamTimelineItemIdentity, type StreamItem } from "@/types/stream";

export type TimelineHistoryPage = Awaited<ReturnType<DaemonClient["fetchAgentTimelineHistory"]>>;

export interface LoadedHistoryMiddle {
  entries: NonNullable<TimelineHistoryPage["entries"]>;
  nextIndex: number;
  coveredBytes: number;
  oversized: NonNullable<TimelineHistoryPage["oversized"]>;
  target?: {
    entries: NonNullable<TimelineHistoryPage["entries"]>;
    startIndex: number;
    endIndex: number;
    coveredBytes: number;
    oversized: NonNullable<TimelineHistoryPage["oversized"]>;
  };
}

function hydrate(entries: NonNullable<TimelineHistoryPage["entries"]>): StreamItem[] {
  const items = hydrateStreamState(
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
  const positions = new Map<string, number>();
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === "assistant_message" && item.messageId)
      positions.set(`assistant:${item.messageId}`, entry.index);
    if (item.type === "user_message")
      positions.set(`user:${item.messageId ?? item.clientMessageId ?? ""}`, entry.index);
  }
  return items.map((item) => {
    const key = identity(item);
    return key && positions.has(key)
      ? Object.assign({}, item, { providerHistoryIndex: positions.get(key) })
      : item;
  });
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
  const tailStart = snapshot.tail?.[0]?.index ?? snapshot.totalEvents ?? Infinity;
  const targetEntries = middle?.target?.entries ?? [];
  const mid = hydrate(
    [
      ...(middle?.entries ?? []),
      ...targetEntries.filter((entry) => entry.index < tailStart),
    ].toSorted((a, b) => a.index - b.index),
  );
  const next = middle?.nextIndex ?? snapshot.gap.startIndex;
  const { gaps, omissions } = gapPresentation(snapshot, middle, next);
  const history = [
    ...head,
    ...mid,
    ...omissions,
    ...gaps,
    ...tail,
    ...hydrate(targetEntries.filter((entry) => entry.index >= tailStart)),
  ];
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
      history[index] = { ...item, providerHistoryIndex: history[index].providerHistoryIndex };
      continue;
    }
    if (!item.timelineCursor || item.timelineCursor.seq > boundary) history.push(item);
  }
  return history;
}

function gapPresentation(
  snapshot: TimelineHistoryPage,
  middle: LoadedHistoryMiddle | null,
  next: number,
) {
  if (!snapshot.gap) return { gaps: [], omissions: [] };
  const targetCount = middle?.target
    ? Math.max(
        0,
        Math.min(snapshot.gap.endIndex + 1, middle.target.endIndex) -
          Math.max(next, middle.target.startIndex),
      )
    : 0;
  const count = Math.max(0, snapshot.gap.endIndex + 1 - next - targetCount);
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
            bytes: Math.max(
              0,
              snapshot.gap.bytes -
                (middle?.coveredBytes ?? 0) -
                (targetCount > 0 ? (middle?.target?.coveredBytes ?? 0) : 0),
            ),
          },
        },
      ]
    : [];
  const omissions: StreamItem[] = [
    ...(middle?.oversized ?? []),
    ...(middle?.target?.oversized ?? []),
  ].map((entry) => ({
    kind: "notification",
    sourceType: "notification",
    id: `history-oversized:${snapshot.epoch}:${entry.index}`,
    timestamp: new Date(0),
    level: "info",
    message: `History item exceeds the page limit (${entry.bytes.toLocaleString()} bytes).`,
  }));
  return { gaps, omissions };
}
