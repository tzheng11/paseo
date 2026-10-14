import { expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { fetchProjectedTimelineItems, fetchProjectedHistoryPage } from "./timeline.js";

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
