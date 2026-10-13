import { z } from "zod";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type {
  HistoryPage,
  HistoryReadLimit,
  HistoryWindowEntry,
  HistoryWindows,
} from "../../agent-history-replay.js";
import {
  readCodexHistoryIndex,
  type CodexHistoryItemReference,
  type CodexHistoryIndexResult,
} from "./history-index.js";

const itemPage = z.object({
  data: z.array(
    z.object({
      turnId: z.string(),
      item: z.unknown(),
      startedAtMs: z.number().nullish(),
      completedAtMs: z.number().nullish(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export interface CodexHistoryReadClient {
  request(method: string, params?: unknown): Promise<unknown>;
}
export interface CodexHistorySourceOptions {
  databasePath: string;
  threadId: string;
  retainedItemIds?: string[];
  mapItem: (entry: z.infer<typeof itemPage>["data"][number]) => AgentStreamEvent[];
}

/** The native store supplies metadata; the provider remains the item decoder. */
export class CodexHistorySource {
  private initialized: Promise<void> | null = null;

  private ensureProjection(client: CodexHistoryReadClient): Promise<void> {
    if (!this.initialized)
      this.initialized = (async () => {
        // Native imports may have a transcript but no projected rows yet. Ask
        // the provider to index it without sending any item payloads to Node.
        await client.request("thread/turns/list", {
          threadId: this.options.threadId,
          limit: 1,
          sortDirection: "asc",
          itemsView: "notLoaded",
        });
      })();
    return this.initialized;
  }
  constructor(private readonly options: CodexHistorySourceOptions) {}

  /** Explicit full reads keep one provider page, never a complete turn. */
  async *stream(
    client: CodexHistoryReadClient,
    options?: { messagesOnly?: boolean },
  ): AsyncGenerator<HistoryWindowEntry<AgentStreamEvent>> {
    await this.ensureProjection(client);
    let cursor: string | null = null;
    let index = 0;
    const seen = new Set<string>();
    do {
      const page = itemPage.parse(
        await client.request("thread/items/list", {
          threadId: this.options.threadId,
          limit: 8,
          sortDirection: "asc",
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (page.nextCursor !== null && seen.has(page.nextCursor))
        throw new Error("Native history repeated a stream cursor");
      if (page.nextCursor !== null) seen.add(page.nextCursor);
      for (const entry of page.data) {
        const item = entry.item;
        const isMessage =
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          (item.type === "userMessage" || item.type === "agentMessage");
        if (!options?.messagesOnly || isMessage)
          for (const value of this.options.mapItem(entry))
            yield { index, bytes: Buffer.byteLength(JSON.stringify(value), "utf8"), value };
        index++;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async windows(
    client: CodexHistoryReadClient,
    limits: { head: HistoryReadLimit; tail: HistoryReadLimit },
  ): Promise<
    HistoryWindows<AgentStreamEvent> & {
      userMessages: CodexHistoryIndexResult["userMessages"];
      asyncQuestionIds: string[];
    }
  > {
    await this.ensureProjection(client);
    const index = await readCodexHistoryIndex({
      databasePath: this.options.databasePath,
      threadId: this.options.threadId,
      operation: "windows",
      retainedItemIds: this.options.retainedItemIds,
      ...limits,
    });
    const head = await this.decode(client, index.head ?? [], limits.head);
    const tail = await this.decode(client, (index.tail ?? []).toReversed(), limits.tail);
    const start = head.covered.length ? head.covered.at(-1)!.index + 1 : 0;
    const end = tail.covered.length ? tail.covered.at(-1)!.index : index.totalEvents;
    return {
      head: head.entries,
      tail: tail.entries.toSorted((left, right) => left.index - right.index),
      gap:
        start < end
          ? {
              startIndex: start,
              endIndex: end - 1,
              count: end - start,
              bytes:
                index.totalBytes -
                [...head.covered, ...tail.covered].reduce((sum, ref) => sum + ref.bytes, 0),
            }
          : null,
      totalEvents: index.totalEvents,
      totalBytes: index.totalBytes,
      userMessages: index.userMessages,
      asyncQuestionIds: index.asyncQuestionIds,
    };
  }

  async page(
    client: CodexHistoryReadClient,
    options: { cursor: number; direction: "before" | "after"; limit: HistoryReadLimit },
  ): Promise<HistoryPage<AgentStreamEvent>> {
    await this.ensureProjection(client);
    const index = await readCodexHistoryIndex({
      databasePath: this.options.databasePath,
      threadId: this.options.threadId,
      operation: "page",
      ...options,
    });
    const refs =
      options.direction === "before" ? (index.entries ?? []).toReversed() : (index.entries ?? []);
    const decoded = await this.decode(client, refs, options.limit, true);
    const stop = decoded.stopIndex;
    const oversized = [...(index.oversized ?? []), ...decoded.oversized].filter(
      (entry) =>
        stop === null || (options.direction === "before" ? entry.index > stop : entry.index < stop),
    );
    let nextCursor = index.nextCursor ?? null;
    if (stop !== null) nextCursor = options.direction === "before" ? stop + 1 : stop;
    let coveredCount = Math.abs((nextCursor ?? 0) - options.cursor);
    if (nextCursor === null)
      coveredCount =
        options.direction === "before" ? options.cursor : index.totalEvents - options.cursor;
    return {
      entries: decoded.entries.toSorted((left, right) => left.index - right.index),
      oversized: oversized.toSorted((left, right) => left.index - right.index),
      nextCursor,
      coveredCount,
      coveredBytes:
        refs
          .filter(
            (entry) =>
              stop === null ||
              (options.direction === "before" ? entry.index > stop : entry.index < stop),
          )
          .reduce((sum, entry) => sum + entry.bytes, 0) +
        (index.oversized ?? [])
          .filter(
            (entry) =>
              stop === null ||
              (options.direction === "before" ? entry.index > stop : entry.index < stop),
          )
          .reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }

  private async decode(
    client: CodexHistoryReadClient,
    refs: CodexHistoryItemReference[],
    limit: HistoryReadLimit,
    skipOversized = false,
  ): Promise<{
    entries: HistoryWindowEntry<AgentStreamEvent>[];
    covered: CodexHistoryItemReference[];
    oversized: Array<{ index: number; bytes: number }>;
    stopIndex: number | null;
  }> {
    const entries: HistoryWindowEntry<AgentStreamEvent>[] = [],
      covered: CodexHistoryItemReference[] = [];
    let bytes = 0;
    const oversized: Array<{ index: number; bytes: number }> = [];
    let stopIndex: number | null = null;
    for (const ref of refs) {
      const page = itemPage.parse(
        await client.request("thread/items/list", {
          threadId: this.options.threadId,
          turnId: ref.turnId,
          limit: 1,
          sortDirection: "asc",
          ...(ref.previousItemId ? { cursor: { type: "item", itemId: ref.previousItemId } } : {}),
        }),
      );
      const entry = page.data[0];
      if (
        !entry ||
        typeof entry.item !== "object" ||
        entry.item === null ||
        !("id" in entry.item) ||
        entry.item.id !== ref.itemId ||
        entry.turnId !== ref.turnId
      )
        throw new Error("Native history changed while reading its bounded window");
      const values = this.options.mapItem(entry);
      const sizes = values.map((value) => Buffer.byteLength(JSON.stringify(value) + "\n", "utf8"));
      const size = sizes.reduce((sum, value) => sum + value, 0);
      if (skipOversized && (size > limit.bytes || values.length > limit.events)) {
        oversized.push({ index: ref.index, bytes: size });
        continue;
      }
      if (entries.length + values.length > limit.events || bytes + size > limit.bytes) {
        stopIndex = ref.index;
        break;
      }
      for (let offset = 0; offset < values.length; offset++)
        entries.push({ index: ref.index, bytes: sizes[offset], value: values[offset] });
      covered.push(ref);
      bytes += size;
    }
    return { entries, covered, oversized, stopIndex };
  }
}
