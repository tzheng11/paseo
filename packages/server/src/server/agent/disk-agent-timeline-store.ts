import { pruneAbandonedHistoryCaches } from "./agent-history-cache-directory.js";
import type { HistoryReadLimit, HistoryWindows } from "./agent-history-replay.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { LRUCache } from "lru-cache";
import { setImmediate } from "node:timers/promises";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentRuntimeTimelineStore,
  SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStreamOptions,
} from "./agent-timeline-store-types.js";
import {
  mergeProjectedTimelineRow,
  projectTimelineRows,
  selectProjectedEntriesPage,
  type ProjectedTimelineRow,
} from "./timeline-projection.js";

interface TimelineState {
  key: string;
  epoch: string;
  minSeq: number;
  nextSeq: number;
  count: number;
  bytes: number;
}

interface PreparedTimelineFetch {
  state: TimelineState;
  positions: Iterable<number>;
  finish(entries: ProjectedTimelineRow[]): AgentTimelineFetchResult;
}

interface WholeTurnSelection {
  positions: Iterable<number>;
  page: Pick<AgentTimelineFetchResult, "startSeq" | "endSeq" | "hasOlder" | "hasNewer">;
}

/** Disposable projection cache. Provider transcripts remain authoritative. */
export class DiskAgentTimelineStore implements AgentRuntimeTimelineStore {
  private readonly database: DatabaseSync;
  private readonly directory: string;
  private readonly states = new Map<string, TimelineState>();
  private readonly statements = new Map<string, StatementSync>();
  private readonly cache: LRUCache<string, string>;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  static async create(options: {
    directory: string;
    cacheBytes?: number;
  }): Promise<DiskAgentTimelineStore> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await pruneAbandonedHistoryCaches(options.directory, "timeline-");
    const directory = await mkdtemp(path.join(options.directory, `timeline-${process.pid}-`));
    try {
      return new DiskAgentTimelineStore(directory, options.cacheBytes);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private constructor(directory: string, cacheBytes?: number) {
    this.directory = directory;
    this.database = new DatabaseSync(path.join(this.directory, "projection.sqlite"));
    this.cache = new LRUCache({
      maxSize: cacheBytes ?? 32 * 1024 * 1024,
      // Retain serialized strings, not parsed object graphs. Account for UTF-16
      // characters, keys, and per-entry overhead; oversized rows bypass the cache.
      sizeCalculation: (value, key) => 2 * (value.length + key.length) + 256,
    });
    try {
      this.database.exec(`
      -- This cache is rebuilt from provider transcripts after a process exit.
      -- Keep transaction rollback, without synchronously writing and unlinking
      -- a disk journal for every streamed projection update.
      PRAGMA journal_mode = MEMORY;
      PRAGMA synchronous = OFF;
      PRAGMA cache_size = -4096;
      PRAGMA temp_store = FILE;
      CREATE TABLE rows (
        sid TEXT NOT NULL, pos INTEGER NOT NULL, seq_start INTEGER NOT NULL,
        seq_end INTEGER NOT NULL, identity TEXT, user_id TEXT, item_type TEXT NOT NULL, data_bytes INTEGER NOT NULL,
        turn_id TEXT, turn_trigger INTEGER NOT NULL, turn_start INTEGER NOT NULL,
        PRIMARY KEY (sid, pos)
      ) WITHOUT ROWID;
      CREATE TABLE payloads (
        sid TEXT NOT NULL, pos INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (sid, pos)
      ) WITHOUT ROWID;
      CREATE INDEX rows_identity ON rows(sid, identity, pos);
      CREATE INDEX rows_user ON rows(sid, user_id, pos);
      CREATE INDEX rows_start ON rows(sid, seq_start, pos);
      CREATE INDEX rows_end ON rows(sid, seq_end, pos);
      CREATE INDEX rows_type ON rows(sid, item_type, pos);
      CREATE INDEX rows_turn_start ON rows(sid, turn_start, pos);
      CREATE TABLE ranges (
        sid TEXT NOT NULL, pos INTEGER NOT NULL, start_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL, PRIMARY KEY (sid, pos, start_seq)
      ) WITHOUT ROWID;
      CREATE INDEX ranges_end ON ranges(sid, end_seq, start_seq, pos);
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get cachedBytes(): number {
    return this.cache.calculatedSize;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.database.close();
    this.closed = true;
    this.cache.clear();
    this.statements.clear();
    this.states.clear();
    this.closePromise = rm(this.directory, { recursive: true, force: true });
    return this.closePromise;
  }

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const previous = this.states.get(agentId);
    const state: TimelineState = {
      key: randomUUID(),
      epoch: options?.epoch ?? randomUUID(),
      minSeq: 0,
      nextSeq: options?.nextSeq ?? 1,
      count: 0,
      bytes: 0,
    };
    const timestamp = options?.timestamp ?? new Date().toISOString();
    this.transaction(() => {
      if (options?.rows?.length) {
        for (const row of options.rows) this.projectRow(state, row);
      } else {
        for (const item of options?.items ?? []) {
          this.projectRow(state, { seq: state.nextSeq, timestamp, item });
        }
      }
      if (previous) this.deleteRows(previous.key);
    });
    this.states.set(agentId, state);
  }

  delete(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state) return;
    this.transaction(() => this.deleteRows(state.key));
    this.states.delete(agentId);
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }
  getNextSeq(agentId: string): number {
    return this.requireState(agentId).nextSeq;
  }
  getCount(agentId: string): number {
    return this.requireState(agentId).count;
  }
  getRecentItems(agentId: string, limit: number): AgentTimelineItem[] {
    const state = this.requireState(agentId);
    const count = Math.max(0, Math.floor(limit));
    const positions = this.statement(
      "SELECT pos FROM rows WHERE sid = ? ORDER BY pos DESC LIMIT ?",
    ).all(state.key, count === 0 ? -1 : count);
    return positions.toReversed().map((row) => this.readRow(state, Number(row.pos)).item);
  }

  readWindows(
    agentId: string,
    limits: { head: HistoryReadLimit; tail: HistoryReadLimit },
  ): HistoryWindows<AgentTimelineItem> {
    const state = this.requireState(agentId);
    const select = (direction: "ASC" | "DESC", limit: HistoryReadLimit, boundary: number) => {
      const candidates = this.statement(`SELECT pos, data_bytes AS bytes FROM rows
        WHERE sid = ? AND pos >= ? ORDER BY pos ${direction} LIMIT ?`).all(
        state.key,
        boundary,
        limit.events,
      );
      const selected: Array<{ index: number; bytes: number; value: AgentTimelineItem }> = [];
      let bytes = 0;
      for (const row of candidates) {
        const size = Number(row.bytes);
        if (bytes + size > limit.bytes) break;
        selected.push({
          index: Number(row.pos),
          bytes: size,
          value: this.readRow(state, Number(row.pos)).item,
        });
        bytes += size;
      }
      return selected;
    };
    const head = select("ASC", limits.head, 0);
    const tail = select("DESC", limits.tail, head.length).toReversed();
    const end = tail[0]?.index ?? state.count;
    return {
      head,
      tail,
      totalEvents: state.count,
      totalBytes: state.bytes,
      gap:
        head.length < end
          ? {
              startIndex: head.length,
              endIndex: end - 1,
              count: end - head.length,
              bytes: state.bytes - [...head, ...tail].reduce((sum, entry) => sum + entry.bytes, 0),
            }
          : null,
    };
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.getRows(agentId).map((row) => row.item);
  }
  getRows(agentId: string): ProjectedTimelineRow[] {
    const state = this.requireState(agentId);
    return this.readRows(state, 0);
  }

  /** Explicit full-history access without an array of decoded payloads. */
  async *streamRows(
    agentId: string,
    options?: AgentTimelineStreamOptions,
  ): AsyncGenerator<ProjectedTimelineRow> {
    const state = this.requireState(agentId);
    const count = state.count,
      nextSeq = state.nextSeq;
    let lastYield = performance.now();
    let decoded = 0;
    const assertCurrent = () => {
      if (this.states.get(agentId) !== state || state.nextSeq !== nextSeq)
        throw new Error("History changed during streamed read");
    };
    const positions = options?.userMessagesOnly
      ? this.userMessagePositions(state, count, assertCurrent)
      : this.rowPositions(0, count);
    for (const pos of positions) {
      assertCurrent();
      yield this.readRow(state, pos);
      if (++decoded >= 32 || performance.now() - lastYield >= 4) {
        await setImmediate();
        decoded = 0;
        lastYield = performance.now();
      }
    }
    assertCurrent();
  }

  private *userMessagePositions(
    state: TimelineState,
    count: number,
    assertCurrent: () => void,
  ): Generator<number> {
    let after = -1;
    while (after < count - 1) {
      assertCurrent();
      // rows_type covers this metadata page. Tool and assistant payloads never
      // enter the row cache or decoder just to build the prompt outline.
      const page = this.statement(`SELECT pos FROM rows
        WHERE sid = ? AND item_type = 'user_message' AND pos > ? AND pos < ?
        ORDER BY pos LIMIT 128`).all(state.key, after, count);
      if (!page.length) return;
      for (const row of page) {
        after = Number(row.pos);
        yield after;
      }
    }
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const found = this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND user_id = ? ORDER BY pos LIMIT 1",
    ).get(state.key, clientMessageId);
    return found ? this.readRow(state, Number(found.pos)) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const found = this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND user_id = ? ORDER BY pos LIMIT 1",
    ).get(state.key, clientMessageId);
    if (!found) return null;
    const pos = Number(found.pos);
    const row = { ...this.readRow(state, pos), providerMessageId };
    this.transaction(() => this.writeRow(state, pos, row));
    return row;
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    const previous = { ...state };
    try {
      this.transaction(() => this.projectRow(state, row));
    } catch (error) {
      Object.assign(state, previous);
      throw error;
    }
    return row;
  }

  appendBatch(
    agentId: string,
    entries: readonly { item: AgentTimelineItem; timestamp?: string }[],
  ): AgentTimelineRow[] {
    const state = this.requireState(agentId);
    const previous = { ...state };
    try {
      return this.transaction(() =>
        entries.map(({ item, timestamp }) => {
          const row = {
            seq: state.nextSeq,
            timestamp: timestamp ?? new Date().toISOString(),
            item,
          };
          this.projectRow(state, row);
          return row;
        }),
      );
    } catch (error) {
      Object.assign(state, previous);
      throw error;
    }
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    const found = this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND seq_end = ? ORDER BY pos LIMIT 1",
    ).get(state.key, state.nextSeq - 1);
    return found ? this.readRow(state, Number(found.pos)).item : null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const state = this.requireState(agentId);
    const found = this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND item_type = 'assistant_message' ORDER BY pos DESC LIMIT 1",
    ).get(state.key);
    const item = found ? this.readRow(state, Number(found.pos)).item : null;
    return item?.type === "assistant_message" ? item.text : null;
  }

  getLastAssistantMessageSegment(agentId: string): string | null {
    return this.getLastAssistantMessageSegmentInfo(agentId)?.text ?? null;
  }

  getLastAssistantMessageSegmentInfo(
    agentId: string,
  ): { text: string; startsAtBeginning: boolean } | null {
    const state = this.requireState(agentId);
    const found = this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND item_type = 'assistant_message' ORDER BY pos DESC LIMIT 1",
    ).get(state.key);
    if (!found) return null;
    const chunks: string[] = [];
    let pos = Number(found.pos);
    for (; pos >= 0; pos--) {
      const item = this.readRow(state, pos).item;
      if (item.type !== "assistant_message") break;
      chunks.push(item.text);
    }
    return { text: chunks.toReversed().join(""), startsAtBeginning: pos < 0 };
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const page = this.prepareFetch(agentId, options);
    return page.finish(Array.from(page.positions, (pos) => this.readRow(page.state, pos)));
  }

  async fetchAsync(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const page = this.prepareFetch(agentId, options);
    const state = page.state;
    const nextSeq = state.nextSeq;
    const entries: ProjectedTimelineRow[] = [];
    let started = performance.now();
    let decoded = 0;
    const assertCurrent = () => {
      if (this.closed || this.states.get(agentId) !== state || state.nextSeq !== nextSeq)
        throw new Error("History changed during paged read");
    };
    for (const pos of page.positions) {
      assertCurrent();
      entries.push(this.readRow(state, pos));
      // Tool updates can expand even a one-item tail across the entire timeline.
      // Yield while decoding it, without weakening the page's coverage/cursors.
      if (++decoded >= 32 || performance.now() - started >= 4) {
        await setImmediate();
        decoded = 0;
        started = performance.now();
      }
    }
    assertCurrent();
    return page.finish(entries);
  }

  private prepareFetch(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): PreparedTimelineFetch {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const limit = Math.max(0, Math.floor(options?.limit ?? 200));
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      state.count > 0 &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const selectedDirection = reset ? "tail" : direction;
    const whole =
      options?.wholeTurns && selectedDirection !== "after"
        ? this.selectWholeTurnPositions(state, selectedDirection, cursor?.seq, limit)
        : null;
    const selected = this.selectPositions(state, selectedDirection, cursor?.seq, limit);
    const positions = whole?.positions ?? selected.positions;
    const hasOlder = selected.hasOlder;
    return {
      state,
      positions,
      finish: (entries) => {
        if (whole)
          return {
            epoch: state.epoch,
            direction,
            reset,
            staleCursor,
            gap,
            window,
            ...whole.page,
            rows: entries,
          };
        const page = selectProjectedEntriesPage({
          entries,
          bounds: window,
          direction: selectedDirection,
          cursorSeq: cursor?.seq,
          limit: 0,
        });
        return {
          epoch: state.epoch,
          direction,
          reset,
          staleCursor,
          gap,
          window,
          hasOlder: hasOlder ?? page.hasOlder,
          hasNewer: page.hasNewer,
          startSeq: page.startSeq,
          endSeq: page.endSeq,
          rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
        };
      },
    };
  }

  private selectPositions(
    state: TimelineState,
    selectedDirection: "tail" | "before" | "after",
    cursorSeq: number | undefined,
    limit: number,
  ): { positions: Iterable<number>; hasOlder?: boolean } {
    let selected: Iterable<number>;
    let hasOlder: boolean | undefined;
    if (state.count === 0) {
      selected = [];
    } else if (selectedDirection === "tail") {
      let start = limit === 0 ? 0 : Math.max(0, state.count - limit);
      // An old tool anchor can own new source events. Expand transitively just as
      // the memory projection does, so the cursor never certifies a missing row.
      while (start > 0) {
        const row = this.statement("SELECT seq_start FROM rows WHERE sid = ? AND pos = ?").get(
          state.key,
          start,
        )!;
        const overlap = this.statement(
          "SELECT MIN(pos) AS pos FROM rows WHERE sid = ? AND pos < ? AND seq_end >= ?",
        ).get(state.key, start, row.seq_start);
        if (overlap?.pos === null || overlap?.pos === undefined) break;
        start = Number(overlap.pos);
      }
      selected = this.rowPositions(start, state.count);
      hasOlder = start > 0;
    } else if (selectedDirection === "before") {
      const endSeq = Math.min(state.nextSeq - 1, (cursorSeq ?? state.nextSeq) - 1);
      const positions = this.statement(
        "SELECT pos FROM rows WHERE sid = ? AND seq_start <= ? ORDER BY pos DESC LIMIT ?",
      ).all(state.key, endSeq, limit === 0 ? -1 : limit + 1);
      hasOlder = limit > 0 && positions.length > limit;
      if (hasOlder) positions.pop();
      selected = positions.toReversed().map((row) => Number(row.pos));
    } else {
      const startSeq = Math.max(state.minSeq, (cursorSeq ?? state.minSeq - 1) + 1);
      const positions = this.statement(`SELECT pos, MIN(MAX(start_seq, ?)) AS first_seq FROM ranges
        WHERE sid = ? AND end_seq >= ? AND start_seq <= ? GROUP BY pos ORDER BY first_seq, pos LIMIT ?`).all(
        startSeq,
        state.key,
        startSeq,
        state.nextSeq - 1,
        limit === 0 ? -1 : limit,
      );
      selected = positions
        .sort((a, b) => Number(a.pos) - Number(b.pos))
        .map((row) => Number(row.pos));
    }
    return { positions: selected, hasOlder };
  }

  private selectWholeTurnPositions(
    state: TimelineState,
    direction: "tail" | "before",
    cursorSeq: number | undefined,
    limit: number,
  ): WholeTurnSelection | null {
    if (state.count === 0) return null;
    let stop = state.count;
    if (direction === "before") {
      const endSeq = Math.min(state.nextSeq - 1, (cursorSeq ?? state.nextSeq) - 1);
      const last = this.statement(
        "SELECT pos FROM rows WHERE sid = ? AND seq_start <= ? ORDER BY pos DESC LIMIT 1",
      ).get(state.key, endSeq);
      if (!last) return null;
      stop = Number(last.pos) + 1;
    }
    const requestedStart = limit === 0 ? 0 : Math.max(0, stop - limit);
    const start = this.wholeTurnWindowStart(state, requestedStart);
    if (direction === "before" && stop < state.count) {
      const nextTurn = this.statement(
        "SELECT pos FROM rows WHERE sid = ? AND turn_start = 1 AND pos >= ? ORDER BY pos LIMIT 1",
      ).get(state.key, stop);
      stop = nextTurn ? Number(nextTurn.pos) : state.count;
    }
    const first = this.statement("SELECT seq_start FROM rows WHERE sid = ? AND pos = ?").get(
      state.key,
      start,
    )!;
    const next =
      stop === state.count
        ? null
        : this.statement("SELECT seq_start FROM rows WHERE sid = ? AND pos = ?").get(
            state.key,
            stop,
          )!;
    const endSeq = next ? Number(next.seq_start) - 1 : state.nextSeq - 1;
    return {
      positions: this.rowPositions(start, stop),
      page: {
        startSeq: Number(first.seq_start),
        endSeq,
        hasOlder: start > 0,
        hasNewer: endSeq < state.nextSeq - 1,
      },
    };
  }

  private wholeTurnWindowStart(state: TimelineState, requestedStart: number): number {
    let start = requestedStart;
    while (start > 0) {
      const boundary = this.statement(
        "SELECT pos, seq_start FROM rows WHERE sid = ? AND turn_start = 1 AND pos <= ? ORDER BY pos DESC LIMIT 1",
      ).get(state.key, start)!;
      start = Number(boundary.pos);
      const overlap = this.statement(
        "SELECT MIN(pos) AS pos FROM rows WHERE sid = ? AND pos < ? AND seq_end >= ?",
      ).get(state.key, start, boundary.seq_start);
      if (overlap?.pos == null) break;
      start = Number(overlap.pos);
    }
    return start;
  }

  private *rowPositions(start: number, count: number): Generator<number> {
    for (let pos = start; pos < count; pos++) yield pos;
  }

  private projectRow(state: TimelineState, row: AgentTimelineRow): void {
    const entry = projectTimelineRows({ rows: [row], mode: "canonical" })[0];
    const identity = timelineItemIdentity(row.item);
    const found =
      identity === null
        ? undefined
        : this.statement(
            "SELECT pos FROM rows WHERE sid = ? AND identity = ? ORDER BY pos DESC LIMIT 1",
          ).get(state.key, identity);
    const existing = found ? this.readRow(state, Number(found.pos)) : undefined;
    const mergedIdentity = mergeProjectedTimelineRow(existing, entry, "identity");
    if (mergedIdentity && found) {
      this.writeRow(state, Number(found.pos), mergedIdentity);
    } else {
      const previous = state.count > 0 ? this.readRow(state, state.count - 1) : undefined;
      const mergedText = mergeProjectedTimelineRow(previous, entry, "adjacent");
      if (mergedText) this.writeRow(state, state.count - 1, mergedText);
      else {
        this.writeRow(state, state.count, { ...entry, seq: entry.seqEnd });
        state.count++;
      }
    }
    if (state.minSeq === 0) state.minSeq = entry.seqStart;
    state.nextSeq = Math.max(state.nextSeq, row.seq + 1);
  }

  private writeRow(state: TimelineState, pos: number, row: ProjectedTimelineRow): void {
    const data = JSON.stringify(row);
    const bytes = Buffer.byteLength(data, "utf8");
    const previous = this.statement(
      "SELECT data_bytes AS bytes FROM rows WHERE sid = ? AND pos = ?",
    ).get(state.key, pos);
    state.bytes += bytes - Number(previous?.bytes ?? 0);
    const previousTurn =
      pos === 0
        ? null
        : this.statement("SELECT turn_id FROM rows WHERE sid = ? AND pos = ?").get(
            state.key,
            pos - 1,
          );
    const previousTurnId =
      typeof previousTurn?.turn_id === "string" ? previousTurn.turn_id : undefined;
    const trigger = isTimelineTurnTrigger(row.item);
    const turnStart = pos === 0 || !continuesTimelineTurn(previousTurnId, row.turnId, trigger);
    this.statement(`INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      state.key,
      pos,
      row.seqStart,
      row.seqEnd,
      timelineItemIdentity(row.item),
      row.item.type === "user_message" ? (row.item.clientMessageId ?? null) : null,
      row.item.type,
      bytes,
      row.turnId ?? null,
      Number(trigger),
      Number(turnStart),
    );
    const successor = this.statement(
      "SELECT turn_id, turn_trigger FROM rows WHERE sid = ? AND pos = ?",
    ).get(state.key, pos + 1);
    if (successor) {
      const successorTurnId = typeof successor.turn_id === "string" ? successor.turn_id : undefined;
      const successorStarts = !continuesTimelineTurn(
        row.turnId,
        successorTurnId,
        successor.turn_trigger === 1,
      );
      this.statement("UPDATE rows SET turn_start = ? WHERE sid = ? AND pos = ?").run(
        Number(successorStarts),
        state.key,
        pos + 1,
      );
    }
    this.statement("INSERT OR REPLACE INTO payloads VALUES (?, ?, ?)").run(state.key, pos, data);
    this.statement("DELETE FROM ranges WHERE sid = ? AND pos = ?").run(state.key, pos);
    for (const range of row.sourceSeqRanges) {
      this.statement("INSERT INTO ranges VALUES (?, ?, ?, ?)").run(
        state.key,
        pos,
        range.startSeq,
        range.endSeq,
      );
    }
    this.cache.set(`${state.key}:${pos}`, data);
  }

  private readRow(state: TimelineState, pos: number): ProjectedTimelineRow {
    const key = `${state.key}:${pos}`;
    let data = this.cache.get(key);
    if (data === undefined) {
      const found = this.statement("SELECT data FROM payloads WHERE sid = ? AND pos = ?").get(
        state.key,
        pos,
      );
      if (typeof found?.data !== "string") throw new Error(`Missing timeline row ${pos}`);
      data = found.data;
      this.cache.set(key, data);
    }
    return JSON.parse(data) as ProjectedTimelineRow;
  }

  private readRows(state: TimelineState, start: number): ProjectedTimelineRow[] {
    const rows: ProjectedTimelineRow[] = [];
    for (const row of this.statement(
      "SELECT pos FROM rows WHERE sid = ? AND pos >= ? ORDER BY pos",
    ).iterate(state.key, start)) {
      rows.push(this.readRow(state, Number(row.pos)));
    }
    return rows;
  }

  private deleteRows(key: string): void {
    this.statement("DELETE FROM ranges WHERE sid = ?").run(key);
    this.statement("DELETE FROM rows WHERE sid = ?").run(key);
    this.statement("DELETE FROM payloads WHERE sid = ?").run(key);
    this.cache.clear();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.cache.clear();
      throw error;
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private requireState(agentId: string): TimelineState {
    const state = this.states.get(agentId);
    if (!state) throw new Error(`Unknown agent '${agentId}'`);
    return state;
  }
}
