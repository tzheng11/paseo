import pLimit from "p-limit";
import { Worker } from "node:worker_threads";
import type { HistoryReadLimit } from "../../agent-history-replay.js";

export interface CodexHistoryItemReference {
  itemId: string;
  turnId: string;
  previousItemId: string | null;
  ordinal: number;
  index: number;
  bytes: number;
}
export interface CodexHistoryIndexResult {
  totalEvents: number;
  totalBytes: number;
  version: string;
  payloadsDecoded: number;
  userMessages: Array<{ messageId: string; turnId: string }>;
  asyncQuestionIds: string[];
  head?: CodexHistoryItemReference[];
  tail?: CodexHistoryItemReference[];
  gap?: { startIndex: number; endIndex: number; count: number; bytes: number } | null;
  entries?: CodexHistoryItemReference[];
  oversized?: Array<{ index: number; bytes: number }>;
  nextCursor?: number | null;
}
export type CodexHistoryIndexRequest = {
  databasePath: string;
  threadId: string;
  retainedItemIds?: string[];
} & (
  | { operation: "windows"; head: HistoryReadLimit; tail: HistoryReadLimit }
  | { operation: "page"; cursor: number; direction: "before" | "after"; limit: HistoryReadLimit }
);

/** SQLite scans run in their own isolate, never on the daemon's main loop. */
const indexReads = pLimit(2);

export function readCodexHistoryIndex(
  request: CodexHistoryIndexRequest,
): Promise<CodexHistoryIndexResult> {
  return indexReads(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./history-index-worker.mjs", import.meta.url), {
          workerData: request,
        });
        let settled = false;
        worker.once(
          "message",
          (reply: { ok: boolean; result?: CodexHistoryIndexResult; errorName?: string }) => {
            settled = true;
            if (reply.ok && reply.result) resolve(reply.result);
            else
              reject(
                new Error(`Native history index read failed (${reply.errorName ?? "unknown"})`),
              );
          },
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!settled)
            reject(new Error(`Native history index worker exited before replying (${code})`));
        });
      }),
  );
}
