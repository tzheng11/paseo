import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

class HistoryWork {
  private deadline = performance.now() + 4;
  private entries = 0;
  private bytes = 0;
  private pending: Promise<void> | null = null;

  pause(bytes = 0): Promise<void> | undefined {
    if (this.pending) return this.pending;
    this.entries += 1;
    this.bytes += bytes;
    if (this.entries < 128 && this.bytes < 256 * 1024 && performance.now() < this.deadline) return;
    this.pending = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.entries = 0;
        this.bytes = 0;
        this.deadline = performance.now() + 4;
        this.pending = null;
        resolve();
      });
    });
    return this.pending;
  }
}

// Concurrent chat opens share a budget; per-session budgets can monopolize one turn together.
export const historyWork = new HistoryWork();

export async function* readClaudeHistoryRecords(
  filePath: string,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    if (size === 0) return;
    // Freeze the read boundary so a provider appending during replay cannot extend it indefinitely.
    const input = file.createReadStream({
      encoding: "utf8",
      highWaterMark: 64 * 1024,
      end: size - 1,
      autoClose: false,
      signal,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const pause = historyWork.pause(line.length);
        if (pause) await pause;
        signal.throwIfAborted();
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Claude can leave a partial final row when a process exits during a write.
          continue;
        }
        if (isHistoryRecord(parsed)) yield parsed;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } finally {
    await file.close();
  }
}

function isHistoryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
