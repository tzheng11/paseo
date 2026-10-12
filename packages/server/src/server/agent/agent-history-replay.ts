import { pruneAbandonedHistoryCaches } from "./agent-history-cache-directory.js";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

let prunedAbandonedReplays = false;

/** Stage a replay before replacing a readable timeline, without retaining its payloads. */
export class AgentHistoryReplay<T> {
  private pending = "";
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
    try {
      replay.file = await open(path.join(directory, "events.jsonl"), "wx", 0o600);
      for await (const event of events) {
        const line = JSON.stringify(event) + "\n";
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
