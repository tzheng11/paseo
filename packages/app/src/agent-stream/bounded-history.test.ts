import { expect, test } from "vitest";
import { buildBoundedHistoryPresentation, type TimelineHistoryPage } from "./bounded-history";
import { hydrateStreamState } from "@/types/stream";

function entry(index: number) {
  return {
    index,
    bytes: 100,
    provider: "codex",
    timestamp: "2026-10-12T00:00:00Z",
    item: { type: "assistant_message" as const, messageId: String(index), text: `Item ${index}` },
  };
}
const snapshot: TimelineHistoryPage = {
  requestId: "r",
  agentId: "agent",
  epoch: "e",
  unit: "provider_items",
  liveAfterSeq: 4,
  head: [entry(0), entry(1)],
  tail: [entry(8), entry(9)],
  gap: { startIndex: 2, endIndex: 7, count: 6, bytes: 600 },
  totalEvents: 10,
  totalBytes: 1000,
  error: null,
};

test("renders a bounded jump page in source order without inventing live cursors", () => {
  const items = buildBoundedHistoryPresentation({
    snapshot,
    live: [],
    middle: {
      entries: [],
      nextIndex: 2,
      coveredBytes: 0,
      oversized: [],
      target: { entries: [entry(5)], startIndex: 5, endIndex: 6, coveredBytes: 100, oversized: [] },
    },
  });
  const target = items.find((item) => item.providerHistoryIndex === 5);
  expect(target?.kind).toBe("assistant_message");
  expect(target?.timelineCursor).toBeUndefined();
  const gap = items.find((item) => item.kind === "notification" && item.historyGap);
  expect(gap?.kind === "notification" && gap.historyGap).toEqual({
    cursor: 2,
    count: 5,
    bytes: 500,
  });
});

test("places a newer source page after the original tail without subtracting it from the middle gap", () => {
  const items = buildBoundedHistoryPresentation({
    snapshot,
    live: [],
    middle: {
      entries: [],
      nextIndex: 2,
      coveredBytes: 0,
      oversized: [],
      target: {
        entries: [entry(12)],
        startIndex: 12,
        endIndex: 13,
        coveredBytes: 100,
        oversized: [],
      },
    },
  });
  expect(
    items.filter((item) => item.kind === "assistant_message").map((item) => item.messageId),
  ).toEqual(["0", "1", "8", "9", "12"]);
  const gap = items.find((item) => item.kind === "notification" && item.historyGap);
  expect(gap?.kind === "notification" && gap.historyGap).toEqual({
    cursor: 2,
    count: 6,
    bytes: 600,
  });
});

test("renders the conversation start, exact gap shape and recent work as separate segments", () => {
  const items = buildBoundedHistoryPresentation({ snapshot, middle: null, live: [] });
  expect(items.map((item) => item.kind)).toEqual([
    "assistant_message",
    "assistant_message",
    "notification",
    "assistant_message",
    "assistant_message",
  ]);
  expect(items[2].kind === "notification" && items[2].historyGap).toEqual({
    cursor: 2,
    count: 6,
    bytes: 600,
  });
  expect(
    items.filter((item) => item.kind === "assistant_message").map((item) => item.messageId),
  ).toEqual(["0", "1", "8", "9"]);
});

test("inserts requested middle pages, reduces the gap and retains authoritative live updates", () => {
  const live = hydrateStreamState([
    {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", messageId: "9", text: "Updated tail" },
      },
      timestamp: new Date(0),
      timelineCursor: { epoch: "e", seq: 4 },
    },
    {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", messageId: "new", text: "Live answer" },
      },
      timestamp: new Date(0),
      timelineCursor: { epoch: "e", seq: 5 },
    },
  ]);
  const items = buildBoundedHistoryPresentation({
    snapshot,
    live,
    middle: { entries: [entry(2), entry(3)], nextIndex: 4, coveredBytes: 200, oversized: [] },
  });
  expect(
    items.filter((item) => item.kind === "assistant_message").map((item) => item.messageId),
  ).toEqual(["0", "1", "2", "3", "8", "9", "new"]);
  expect(items.find((item) => item.kind === "notification" && item.historyGap)?.kind).toBe(
    "notification",
  );
  const gap = items.find((item) => item.kind === "notification" && item.historyGap);
  expect(gap?.kind === "notification" && gap.historyGap).toEqual({
    cursor: 4,
    count: 4,
    bytes: 400,
  });
  expect(
    items.some(
      (item) =>
        item.kind === "assistant_message" && item.messageId === "9" && item.text === "Updated tail",
    ),
  ).toBe(true);
});
