import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
  historyIndex?: number;
  messageId?: string;
}

export interface TimelinePromptIndex {
  epoch: string;
  prompts: TimelinePromptIndexEntry[];
}

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
): TimelinePromptIndex {
  return {
    epoch,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message"
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(row.item.text),
            },
          ]
        : [],
    ),
  };
}

/** Retain prompt metadata, never assistant/tool payloads or full user bodies. */
export async function streamTimelinePromptIndex(
  epoch: string,
  rows: AsyncIterable<AgentTimelineRow>,
): Promise<TimelinePromptIndex> {
  const prompts: TimelinePromptIndexEntry[] = [];
  for await (const row of rows) {
    if (row.item.type !== "user_message") continue;
    prompts.push({
      seq: row.seq,
      timestamp: row.timestamp,
      preview: promptPreview(row.item.text),
      ...(row.providerMessageId === undefined ? {} : { messageId: row.providerMessageId }),
      ...(row.historyIndex === undefined ? {} : { historyIndex: row.historyIndex }),
    });
  }
  return { epoch, prompts };
}
