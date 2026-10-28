import { z } from "zod";
import type { AgentHistoryStreamOptions, AgentStreamEvent } from "../../agent-sdk-types.js";
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
type CodexHistoryItemEntry = z.infer<typeof itemPage>["data"][number];
const HISTORY_ITEM_PAGE_SIZE = 8;
const HISTORY_ITEM_PAGE_BYTES = 256 * 1024;
export interface CodexHistoryReadClient {
  request(method: string, params?: unknown): Promise<unknown>;
}
export interface CodexHistorySourceOptions {
  databasePath: string;
  threadId: string;
  retainedItemIds?: string[];
  mapItem: (entry: CodexHistoryItemEntry) => AgentStreamEvent[] | Promise<AgentStreamEvent[]>;
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
    options?: AgentHistoryStreamOptions,
  ): AsyncGenerator<HistoryWindowEntry<AgentStreamEvent>> {
    await this.ensureProjection(client);
    if (options?.messagesOnly || options?.userMessagesOnly) {
      const index = await readCodexHistoryIndex({
        databasePath: this.options.databasePath,
        threadId: this.options.threadId,
        operation: "messages",
        userOnly: options.userMessagesOnly,
      });
      const refs = index.messages ?? [];
      for (const batch of this.batches(refs, HISTORY_ITEM_PAGE_BYTES)) {
        const entries = await this.readBatch(client, batch);
        for (let offset = 0; offset < entries.length; offset++) {
          const entry = entries[offset];
          const ref = batch[offset];
          if (
            typeof entry.item !== "object" ||
            entry.item === null ||
            !("type" in entry.item) ||
            entry.item.type !== ref.messageType
          )
            throw new Error("Native history changed while reading its message selection");
          for (const value of await this.options.mapItem(entry))
            yield {
              index: ref.index,
              bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
              value,
            };
        }
      }
      return;
    }
    let cursor: string | null = null;
    let index = 0;
    const seen = new Set<string>();
    do {
      const page = itemPage.parse(
        await client.request("thread/items/list", {
          threadId: this.options.threadId,
          limit: HISTORY_ITEM_PAGE_SIZE,
          sortDirection: "asc",
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (page.nextCursor !== null && seen.has(page.nextCursor))
        throw new Error("Native history repeated a stream cursor");
      if (page.nextCursor !== null) seen.add(page.nextCursor);
      for (const entry of page.data) {
        for (const value of await this.options.mapItem(entry))
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
    batches: for (const batch of this.batches(refs, limit.bytes)) {
      // A batch contains only selected adjacent items. Never page across a gap
      // or an oversized record, and keep newest-first normalization for tails.
      const nativeEntries = await this.readBatch(client, batch);
      for (let offset = 0; offset < batch.length; offset++) {
        const ref = batch[offset];
        const values = await this.options.mapItem(nativeEntries[offset]);
        const sizes = values.map((value) =>
          Buffer.byteLength(JSON.stringify(value) + "\n", "utf8"),
        );
        const size = sizes.reduce((sum, value) => sum + value, 0);
        if (skipOversized && (size > limit.bytes || values.length > limit.events)) {
          oversized.push({ index: ref.index, bytes: size });
          continue;
        }
        if (entries.length + values.length > limit.events || bytes + size > limit.bytes) {
          stopIndex = ref.index;
          break batches;
        }
        for (let index = 0; index < values.length; index++)
          entries.push({ index: ref.index, bytes: sizes[index], value: values[index] });
        covered.push(ref);
        bytes += size;
      }
    }
    return { entries, covered, oversized, stopIndex };
  }

  private *batches<T extends CodexHistoryItemReference>(
    refs: T[],
    maxBytes: number,
  ): Generator<T[]> {
    const step = refs.length > 1 && refs[0].index > refs[1].index ? -1 : 1;
    for (let start = 0; start < refs.length; ) {
      const batch = [refs[start]];
      let bytes = refs[start].bytes + 384;
      while (batch.length < HISTORY_ITEM_PAGE_SIZE && start + batch.length < refs.length) {
        const next = refs[start + batch.length];
        if (
          next.turnId !== batch[0].turnId ||
          next.index !== batch.at(-1)!.index + step ||
          bytes + next.bytes + 384 > Math.min(HISTORY_ITEM_PAGE_BYTES, maxBytes)
        )
          break;
        batch.push(next);
        bytes += next.bytes + 384;
      }
      yield batch;
      start += batch.length;
    }
  }

  private async readBatch(
    client: CodexHistoryReadClient,
    refs: CodexHistoryItemReference[],
  ): Promise<CodexHistoryItemEntry[]> {
    const backwards = refs[0].index > refs.at(-1)!.index;
    const ascending = backwards ? refs.toReversed() : refs;
    const entries: CodexHistoryItemEntry[] = [];
    while (entries.length < ascending.length) {
      const first = ascending[entries.length];
      const remaining = ascending.length - entries.length;
      const page = itemPage.parse(
        await client.request("thread/items/list", {
          threadId: this.options.threadId,
          turnId: first.turnId,
          limit: remaining,
          sortDirection: "asc",
          ...(first.previousItemId
            ? { cursor: { type: "item", itemId: first.previousItemId } }
            : {}),
        }),
      );
      if (page.data.length === 0 || page.data.length > remaining)
        throw new Error("Native history changed while reading its bounded window");
      for (const entry of page.data) {
        const ref = ascending[entries.length];
        if (
          typeof entry.item !== "object" ||
          entry.item === null ||
          !("id" in entry.item) ||
          entry.item.id !== ref.itemId ||
          entry.turnId !== ref.turnId
        )
          throw new Error("Native history changed while reading its bounded window");
        entries.push(entry);
      }
    }
    return backwards ? entries.toReversed() : entries;
  }
}
