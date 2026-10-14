import type { HistoryReadLimit, HistoryWindows } from "./agent-history-replay.js";
import { randomUUID } from "node:crypto";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: projection.firstSeq,
      nextSeq,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getNextSeq(agentId: string): number {
    return this.requireState(agentId).nextSeq;
  }

  getCount(agentId: string): number {
    return this.requireState(agentId).projection.count;
  }

  getRecentItems(agentId: string, limit: number): AgentTimelineItem[] {
    return this.requireState(agentId).projection.getRecentItems(limit);
  }

  readWindows(
    agentId: string,
    limits: { head: HistoryReadLimit; tail: HistoryReadLimit },
  ): HistoryWindows<AgentTimelineItem> {
    const rows = this.requireState(agentId).projection.getRows();
    const records = rows.map((row, index) => ({
      index,
      bytes: Buffer.byteLength(JSON.stringify(row), "utf8"),
      value: row.item,
    }));
    const head = [];
    let bytes = 0;
    for (const record of records.slice(0, limits.head.events)) {
      if (bytes + record.bytes > limits.head.bytes) break;
      head.push(record);
      bytes += record.bytes;
    }
    const tail = [];
    bytes = 0;
    for (const record of records.slice(head.length).toReversed().slice(0, limits.tail.events)) {
      if (bytes + record.bytes > limits.tail.bytes) break;
      tail.push(record);
      bytes += record.bytes;
    }
    tail.reverse();
    const end = tail[0]?.index ?? records.length;
    const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
    return {
      head,
      tail,
      totalEvents: records.length,
      totalBytes,
      gap:
        head.length < end
          ? {
              startIndex: head.length,
              endIndex: end - 1,
              count: end - head.length,
              bytes: totalBytes - [...head, ...tail].reduce((sum, entry) => sum + entry.bytes, 0),
            }
          : null,
    };
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows();
  }

  async *streamRows(agentId: string): AsyncGenerator<ProjectedTimelineRow> {
    // This store is for tests and small provider-subagent projections. The
    // production disk store decodes one row at a time without collecting it.
    const state = this.requireState(agentId);
    const nextSeq = state.nextSeq;
    for (const row of state.projection.getRows()) {
      if (this.states.get(agentId) !== state || state.nextSeq !== nextSeq)
        throw new Error("History changed during streamed read");
      yield cloneRow(row);
    }
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).projection.findRow(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      state.projection.count > 0 &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  appendBatch(
    agentId: string,
    entries: readonly { item: AgentTimelineItem; timestamp?: string }[],
  ): AgentTimelineRow[] {
    return entries.map(({ item, timestamp }) => this.append(agentId, item, { timestamp }));
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.findRow((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessageSegment(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessageSegment();
  }

  getLastAssistantMessageSegmentInfo(
    agentId: string,
  ): { text: string; startsAtBeginning: boolean } | null {
    // This small in-memory projection is used by tests/subagents; production reads
    // only the final segment from SQLite metadata and payload rows.
    const rows = this.requireState(agentId).projection.getRows();
    const chunks: string[] = [];
    let pos = rows.length - 1;
    for (; pos >= 0; pos--) {
      const item = rows[pos].item;
      if (item.type !== "assistant_message") {
        if (chunks.length) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length
      ? { text: chunks.toReversed().join(""), startsAtBeginning: pos < 0 }
      : null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const row = this.requireState(agentId).projection.findLastRow(
      (candidate) => candidate.item.type === "assistant_message",
    );
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}

export type AgentRuntimeTimelineStore = Pick<
  InMemoryAgentTimelineStore,
  keyof InMemoryAgentTimelineStore
>;
