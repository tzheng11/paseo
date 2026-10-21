import { expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { fetchProjectedTimelineItems, fetchProjectedHistoryPage } from "./timeline.js";
import { fetchAgentHistoryCursorItems } from "../commands/agent/logs.js";

test("fetches a bounded tail and reports the stored middle without materializing it", async () => {
  const fetchAgentTimeline = vi.fn(async () => ({
    entries: [{ item: { type: "assistant_message", text: "Recent" } }],
    historyWindow: { gap: { count: 1000, bytes: 1000000 } },
  }));
  const client = { fetchAgentTimeline } as unknown as DaemonClient;
  const items = await fetchProjectedTimelineItems({ client, agentId: "agent" });
  expect(fetchAgentTimeline).toHaveBeenCalledWith("agent", expect.objectContaining({ limit: 200 }));
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    type: "notification",
    message: expect.stringContaining("History gap:"),
  });
});
test("requests one bounded middle page with its own provider cursor", async () => {
  const fetchAgentTimelineHistory = vi.fn(async () => ({ entries: [], nextCursor: 300 }));
  const client = { fetchAgentTimelineHistory } as unknown as DaemonClient;
  await fetchProjectedHistoryPage({ client, agentId: "agent", cursor: 172, epoch: "e" });
  expect(fetchAgentTimelineHistory).toHaveBeenCalledWith({
    agentId: "agent",
    operation: "page",
    cursor: 172,
    epoch: "e",
    direction: "after",
    limit: { events: 128, bytes: 262144 },
  });
});

test("filters a bounded tail by timestamp while retaining the history gap notice", async () => {
  const fetchAgentTimeline = vi.fn(async () => ({
    entries: [
      { timestamp: "2026-10-20T00:00:00Z", item: { type: "assistant_message", text: "Older" } },
      { timestamp: "2026-10-21T00:00:00Z", item: { type: "assistant_message", text: "Current" } },
    ],
    historyWindow: { gap: { count: 1000, bytes: 1000000 } },
  }));
  const client = { fetchAgentTimeline } as unknown as DaemonClient;
  const items = await fetchProjectedTimelineItems({
    client,
    agentId: "agent",
    sinceTimestampMs: Date.parse("2026-10-21T00:00:00Z"),
  });
  expect(items).toEqual([
    expect.objectContaining({
      type: "notification",
      message: expect.stringContaining("History gap:"),
    }),
    { type: "assistant_message", text: "Current" },
  ]);
});

test("applies a timestamp cutoff to a middle history page and retains its continuation cursor", async () => {
  const fetchAgentTimelineHistory = vi.fn(async () => ({
    entries: [
      { timestamp: "2026-10-20T00:00:00Z", item: { type: "assistant_message", text: "Older" } },
      { timestamp: "2026-10-21T00:00:00Z", item: { type: "assistant_message", text: "Current" } },
      { item: { type: "assistant_message", text: "Undated" } },
    ],
    nextCursor: 300,
  }));
  const client = { fetchAgentTimelineHistory } as unknown as DaemonClient;
  const items = await fetchAgentHistoryCursorItems(
    client,
    "agent",
    "172",
    Date.parse("2026-10-21T00:00:00Z"),
  );
  expect(items).toEqual([
    { type: "notification", level: "info", message: "Next history cursor: 300" },
    { type: "assistant_message", text: "Current" },
  ]);
  expect(fetchAgentTimelineHistory).toHaveBeenCalledTimes(1);
});
