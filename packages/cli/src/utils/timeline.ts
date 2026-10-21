import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const LIVE_HISTORY_FETCH_TIMEOUT_MS = 2_000;

interface FetchProjectedTimelineItemsInput {
  client: DaemonClient;
  agentId: string;
  timeoutMs?: number;
  sinceTimestampMs?: number;
}

export async function fetchProjectedTimelineItems(
  input: FetchProjectedTimelineItemsInput,
): Promise<AgentTimelineItem[]> {
  const timeline = await input.client.fetchAgentTimeline(input.agentId, {
    direction: "tail",
    limit: 200,
    projection: "projected",
    timeout: input.timeoutMs,
  });
  const sinceTimestampMs = input.sinceTimestampMs;
  const entries =
    sinceTimestampMs === undefined
      ? timeline.entries
      : timeline.entries.filter((entry) => Date.parse(entry.timestamp) >= sinceTimestampMs);
  const items = entries.map((entry) => entry.item);
  const gap = timeline.historyWindow?.gap;
  if (gap)
    items.unshift({
      type: "notification",
      level: "info",
      message: `History gap: ${gap.count.toLocaleString()} items (${gap.bytes.toLocaleString()} bytes). Fetch a bounded middle page to read earlier history.`,
    });
  return items;
}

export async function fetchProjectedHistoryPage(
  input: FetchProjectedTimelineItemsInput & { cursor: number; epoch?: string },
) {
  return input.client.fetchAgentTimelineHistory({
    agentId: input.agentId,
    operation: "page",
    cursor: input.cursor,
    epoch: input.epoch,
    direction: "after",
    limit: { events: 128, bytes: 256 * 1024 },
  });
}
