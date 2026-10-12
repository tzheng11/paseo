import { AsyncLocalStorage } from "node:async_hooks";
import { pruneAbandonedHistoryCaches } from "./agent-history-cache-directory.js";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { chmod, copyFile, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface AgentHistoryReadMetrics {
  historyEventsRead: number;
  historyBytesRead: number;
  historyReplayCount: number;
}

const requestHistoryReads = new AsyncLocalStorage<AgentHistoryReadMetrics>();

/** Measure normalized source events once, not spool replay passes or provider file bytes. */
export function withAgentHistoryReadMetrics<T>(
  metrics: AgentHistoryReadMetrics,
  operation: () => Promise<T>,
): Promise<T> {
  return requestHistoryReads.run(metrics, operation);
}

let prunedAbandonedReplays = false;

export interface HistoryReadLimit {
  events: number;
  bytes: number;
}

export interface HistoryWindowEntry<T> {
  index: number;
  bytes: number;
  value: T;
}

export interface HistoryOmission {
  index: number;
  bytes: number;
}

export interface HistoryPage<T> {
  entries: HistoryWindowEntry<T>[];
  oversized: HistoryOmission[];
  nextCursor: number | null;
}

export interface HistoryWindows<T> {
  head: HistoryWindowEntry<T>[];
  tail: HistoryWindowEntry<T>[];
  gap: { startIndex: number; endIndex: number; count: number; bytes: number } | null;
  totalEvents: number;
  totalBytes: number;
}

interface HistoryRecord {
  offset: number;
  bytes: number;
}

function validateLimit(limit: HistoryReadLimit): void {
  if (
    !Number.isSafeInteger(limit.events) ||
    limit.events < 1 ||
    !Number.isSafeInteger(limit.bytes) ||
    limit.bytes < 1
  ) {
    throw new RangeError("History pages require positive event and byte limits");
  }
}

/** Stage a replay before replacing a readable timeline, without retaining its payloads. */
export class AgentHistoryReplay<T> {
  private pending = "";
  private readonly records: HistoryRecord[] = [];
  private bytes = 0;
  private constructor(
    private readonly directory: string,
    private file: FileHandle | null,
  ) {}

  static async create<T>(events: AsyncIterable<T> | Iterable<T>): Promise<AgentHistoryReplay<T>> {
    if (!prunedAbandonedReplays) {
      pruneAbandonedHistoryCaches(tmpdir(), "paseo-history-");
      prunedAbandonedReplays = true;
    }
    const directory = await mkdtemp(path.join(tmpdir(), `paseo-history-${process.pid}-`));
    const replay = new AgentHistoryReplay<T>(directory, null);
    const metrics = requestHistoryReads.getStore();
    if (metrics) metrics.historyReplayCount++;
    try {
      replay.file = await open(path.join(directory, "events.jsonl"), "wx", 0o600);
      for await (const event of events) {
        const line = JSON.stringify(event) + "\n";
        const bytes = Buffer.byteLength(line, "utf8");
        replay.records.push({ offset: replay.bytes, bytes });
        replay.bytes += bytes;
        if (metrics) {
          metrics.historyEventsRead++;
          metrics.historyBytesRead += bytes;
        }
        if (replay.pending.length + line.length > 64 * 1024) await replay.flush();
        replay.pending += line;
      }
      await replay.flush();
      await replay.file.close();
      replay.file = null;
      return replay;
    } catch (error) {
      await replay.close();
      throw error;
    }
  }

  /** Index a frozen JSONL source without parsing any history payloads. */
  static async openJsonl<T>(source: string): Promise<AgentHistoryReplay<T>> {
    const directory = await mkdtemp(path.join(tmpdir(), `paseo-history-${process.pid}-`));
    const replay = new AgentHistoryReplay<T>(directory, null);
    const destination = path.join(directory, "events.jsonl");
    try {
      // Own a stable copy: appends, rewinds and source removal cannot invalidate
      // offsets halfway through a client page or streamed export.
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      const input = createReadStream(destination, { highWaterMark: 64 * 1024 });
      let start = 0;
      try {
        for await (const chunk of input) {
          const buffer = chunk as Buffer;
          start = replay.indexChunk(buffer, start);
          replay.bytes += buffer.length;
        }
      } finally {
        input.destroy();
      }
      if (start < replay.bytes) replay.records.push({ offset: start, bytes: replay.bytes - start });
      return replay;
    } catch (error) {
      await replay.close();
      throw error;
    }
  }

  private indexChunk(buffer: Buffer, start: number): number {
    let newline = -1;
    while ((newline = buffer.indexOf(10, newline + 1)) !== -1) {
      const end = this.bytes + newline + 1;
      if (end - start > 1) this.records.push({ offset: start, bytes: end - start });
      start = end;
    }
    return start;
  }

  /** Decode only the bounded edges. The omitted middle stays on disk. */
  async readWindows(limits: {
    head: HistoryReadLimit;
    tail: HistoryReadLimit;
  }): Promise<HistoryWindows<T>> {
    validateLimit(limits.head);
    validateLimit(limits.tail);
    let headEnd = 0,
      headBytes = 0;
    while (
      headEnd < this.records.length &&
      headEnd < limits.head.events &&
      headBytes + this.records[headEnd].bytes <= limits.head.bytes
    ) {
      headBytes += this.records[headEnd++].bytes;
    }
    let tailStart = this.records.length,
      tailBytes = 0;
    while (
      tailStart > headEnd &&
      this.records.length - tailStart < limits.tail.events &&
      tailBytes + this.records[tailStart - 1].bytes <= limits.tail.bytes
    ) {
      tailBytes += this.records[--tailStart].bytes;
    }
    const file = await open(path.join(this.directory, "events.jsonl"), "r");
    try {
      const head: HistoryWindowEntry<T>[] = [],
        tail: HistoryWindowEntry<T>[] = [];
      for (let index = 0; index < headEnd; index++) head.push(await this.readRecord(file, index));
      for (let index = tailStart; index < this.records.length; index++)
        tail.push(await this.readRecord(file, index));
      return {
        head,
        tail,
        gap:
          headEnd < tailStart
            ? {
                startIndex: headEnd,
                endIndex: tailStart - 1,
                count: tailStart - headEnd,
                bytes:
                  this.records[tailStart - 1].offset +
                  this.records[tailStart - 1].bytes -
                  this.records[headEnd].offset,
              }
            : null,
        totalEvents: this.records.length,
        totalBytes: this.bytes,
      };
    } finally {
      await file.close();
    }
  }

  /** A cursor is the next source index, never an offset into decoded payloads. */
  async readPage(options: {
    cursor: number;
    direction: "before" | "after";
    limit: HistoryReadLimit;
  }): Promise<HistoryPage<T>> {
    validateLimit(options.limit);
    if (
      !Number.isSafeInteger(options.cursor) ||
      options.cursor < 0 ||
      options.cursor > this.records.length
    )
      throw new RangeError("History cursor is outside the indexed source");
    const step = options.direction === "before" ? -1 : 1;
    let index = options.direction === "before" ? options.cursor - 1 : options.cursor;
    let bytes = 0,
      visited = 0;
    const entries: HistoryWindowEntry<T>[] = [],
      oversized: HistoryOmission[] = [];
    const file = await open(path.join(this.directory, "events.jsonl"), "r");
    try {
      while (index >= 0 && index < this.records.length && visited < options.limit.events) {
        const record = this.records[index];
        if (record.bytes > options.limit.bytes) {
          // Do not parse a huge record even when it is the only one in a page.
          oversized.push({ index, bytes: record.bytes });
        } else {
          if (bytes + record.bytes > options.limit.bytes) break;
          entries.push(await this.readRecord(file, index));
          bytes += record.bytes;
        }
        index += step;
        visited++;
      }
      if (step < 0) {
        entries.reverse();
        oversized.reverse();
      }
      let nextCursor: number | null = null;
      if (index >= 0 && index < this.records.length) nextCursor = step < 0 ? index + 1 : index;
      return {
        entries,
        oversized,
        nextCursor,
      };
    } finally {
      await file.close();
    }
  }

  private async readRecord(file: FileHandle, index: number): Promise<HistoryWindowEntry<T>> {
    const record = this.records[index];
    const buffer = Buffer.allocUnsafe(record.bytes);
    let read = 0;
    while (read < record.bytes) {
      const result = await file.read(buffer, read, record.bytes - read, record.offset + read);
      if (!result.bytesRead) throw new Error("History source was truncated while reading a page");
      read += result.bytesRead;
    }
    return { index, bytes: record.bytes, value: JSON.parse(buffer.toString("utf8")) as T };
  }

  /** Full-history consumers must opt into this streamed path explicitly. */
  async *streamAll(): AsyncGenerator<T> {
    yield* this.events();
  }

  async *events(): AsyncGenerator<T> {
    const stream = createReadStream(path.join(this.directory, "events.jsonl"), {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) yield JSON.parse(line) as T;
    } finally {
      reader.close();
      stream.destroy();
    }
  }

  *eventsSync(): Generator<T> {
    const descriptor = openSync(path.join(this.directory, "events.jsonl"), "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    try {
      let bytes: number;
      while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        pending += decoder.write(buffer.subarray(0, bytes));
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          yield JSON.parse(line) as T;
        }
      }
      pending += decoder.end();
      if (pending) yield JSON.parse(pending) as T;
    } finally {
      closeSync(descriptor);
    }
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = null;
    this.pending = "";
    await rm(this.directory, { recursive: true, force: true });
  }

  private async flush(): Promise<void> {
    if (!this.pending) return;
    await this.file!.writeFile(this.pending, "utf8");
    this.pending = "";
  }
}
