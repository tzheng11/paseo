import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { CodexHistorySource } from "./history-source.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

test("streams full message history in provider pages while preserving positions of skipped tools", async () => {
  const calls: unknown[] = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    calls.push(params);
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    const second = z.object({ cursor: z.string().optional() }).parse(params).cursor;
    return second
      ? { data: [{ turnId: "t", item: { id: "last", type: "agentMessage" } }], nextCursor: null }
      : {
          data: [
            { turnId: "t", item: { id: "first", type: "userMessage" } },
            { turnId: "t", item: { id: "tool", type: "mcpToolCall" } },
          ],
          nextCursor: "next",
        };
  });
  const source = new CodexHistorySource({
    databasePath: "unused",
    threadId: "thread",
    mapItem: (entry) => [
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: z.object({ id: z.string() }).parse(entry.item).id,
        },
      },
    ],
  });
  const stream = source.stream({ request }, { messagesOnly: true });
  expect((await stream.next()).value?.index).toBe(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await stream.next()).value?.index).toBe(2);
  expect(calls[1]).toEqual({ threadId: "thread", limit: 8, sortDirection: "asc" });
  expect(calls[2]).toEqual({ threadId: "thread", limit: 8, sortDirection: "asc", cursor: "next" });
  expect((await stream.next()).done).toBe(true);
});

test("decodes only bounded references and preserves attachment order within a source item", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-history-source-"));
  const databasePath = path.join(directory, "history.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
    rollout_ordinal INTEGER, updated_at_ordinal INTEGER, item_type TEXT, item_json TEXT);`);
  const insert = db.prepare(
    "INSERT INTO thread_items VALUES ('thread', 'turn', ?, ?, ?, 'agentMessage', ?)",
  );
  for (let index = 0; index < 10; index++)
    insert.run(
      String(index),
      index + 1,
      index + 1,
      index === 5 ? "x".repeat(100000) : "x".repeat(40),
    );
  db.close();
  const seen: number[] = [];
  const request = vi.fn(async (method: string, raw: unknown) => {
    if (method === "thread/turns/list")
      return { data: [{ id: "turn", items: [] }], nextCursor: null };
    const params = z.object({ cursor: z.object({ itemId: z.string() }).optional() }).parse(raw);
    const index = params.cursor ? Number(params.cursor.itemId) + 1 : 0;
    seen.push(index);
    return { data: [{ turnId: "turn", item: { id: String(index) } }], nextCursor: null };
  });
  const source = new CodexHistorySource({
    databasePath,
    threadId: "thread",
    mapItem: (entry) => {
      const item = z.object({ id: z.string() }).parse(entry.item);
      const events: AgentStreamEvent[] = [
        { type: "timeline", provider: "codex", item: { type: "assistant_message", text: item.id } },
      ];
      if (item.id === "9")
        events.push({
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "attachment" },
        });
      return events;
    },
  });
  try {
    const windows = await source.windows(
      { request },
      { head: { events: 2, bytes: 1000 }, tail: { events: 3, bytes: 1000 } },
    );
    expect(seen).toEqual([0, 1, 9, 8]);
    expect(windows.head.map((entry) => entry.index)).toEqual([0, 1]);
    expect(windows.tail.map((entry) => entry.index)).toEqual([8, 9, 9]);
    expect(
      windows.tail.map((entry) =>
        entry.value.type === "timeline" && entry.value.item.type === "assistant_message"
          ? entry.value.item.text
          : null,
      ),
    ).toEqual(["8", "9", "attachment"]);
    expect(windows.gap).toEqual({ startIndex: 2, endIndex: 7, count: 6, bytes: 100200 });
    expect(
      [...windows.head, ...windows.tail].reduce((sum, entry) => sum + entry.bytes, 0),
    ).toBeLessThan(2000);
    request.mockClear();
    seen.length = 0;
    const page = await source.page(
      { request },
      { cursor: 5, direction: "after", limit: { events: 2, bytes: 1000 } },
    );
    expect(seen).toEqual([6]);
    expect(page.entries[0].index).toBe(6);
    expect(page.oversized).toEqual([{ index: 5, bytes: 100000 }]);
    expect(page.nextCursor).toBe(7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initializes an unindexed native transcript through a metadata-only provider page", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-history-unindexed-"));
  const databasePath = path.join(directory, "history.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT,
    rollout_ordinal INTEGER, updated_at_ordinal INTEGER, item_type TEXT, item_json TEXT);`);
  const calls: string[] = [];
  const request = vi.fn(async (method: string, raw: unknown) => {
    calls.push(method);
    if (method === "thread/turns/list") {
      expect(raw).toMatchObject({ itemsView: "notLoaded", limit: 1 });
      db.prepare(
        "INSERT INTO thread_items VALUES ('thread', 'turn', 'item', 1, 1, 'agentMessage', 'opaque')",
      ).run();
      return { data: [{ id: "turn", items: [] }], nextCursor: null };
    }
    return { data: [{ turnId: "turn", item: { id: "item" } }], nextCursor: null };
  });
  const source = new CodexHistorySource({
    databasePath,
    threadId: "thread",
    mapItem: () => [
      { type: "timeline", provider: "codex", item: { type: "assistant_message", text: "Indexed" } },
    ],
  });
  try {
    const windows = await source.windows(
      { request },
      { head: { events: 1, bytes: 1000 }, tail: { events: 1, bytes: 1000 } },
    );
    expect(windows.totalEvents).toBe(1);
    expect(windows.head).toHaveLength(1);
    expect(calls).toEqual(["thread/turns/list", "thread/items/list"]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
