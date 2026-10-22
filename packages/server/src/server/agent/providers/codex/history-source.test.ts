import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { CodexHistorySource } from "./history-source.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

function nativeHistoryFixture(
  items: Array<{ id: string; turnId: string; text: string; type?: string }>,
  options?: { maxPageSize?: number },
) {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-history-pages-"));
  const databasePath = path.join(directory, "history.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
    rollout_ordinal INTEGER, updated_at_ordinal INTEGER, item_type TEXT, item_json TEXT);
    CREATE INDEX history_order ON thread_items(thread_id, rollout_ordinal);`);
  const insert = db.prepare("INSERT INTO thread_items VALUES ('thread', ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const [index, item] of items.entries())
    insert.run(
      item.turnId,
      item.id,
      index + 1,
      index + 1,
      item.type ?? "agentMessage",
      JSON.stringify(item),
    );
  db.exec("COMMIT");
  db.close();
  const pages: string[][] = [];
  const request = vi.fn(async (method: string, raw: unknown) => {
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    const params = z
      .object({
        turnId: z.string(),
        limit: z.number(),
        cursor: z.object({ itemId: z.string() }).optional(),
      })
      .parse(raw);
    const turn = items.filter((item) => item.turnId === params.turnId);
    const start = params.cursor
      ? turn.findIndex((item) => item.id === params.cursor!.itemId) + 1
      : 0;
    const selected = turn.slice(start, start + Math.min(params.limit, options?.maxPageSize ?? 8));
    pages.push(selected.map((item) => item.id));
    return {
      data: selected.map((item) => ({ turnId: item.turnId, item })),
      nextCursor: start + selected.length < turn.length ? selected.at(-1)!.id : null,
    };
  });
  return {
    databasePath,
    request,
    pages,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("loads bounded edges in eight-item native pages without decoding the omitted middle", async () => {
  const items = Array.from({ length: 640 }, (_, index) => ({
    id: String(index),
    turnId: "turn",
    text: `${index}: café 🧪\0`,
  }));
  const fixture = nativeHistoryFixture(items);
  const mapped: number[] = [];
  const source = new CodexHistorySource({
    databasePath: fixture.databasePath,
    threadId: "thread",
    mapItem: (entry) => {
      const item = z.object({ id: z.string(), text: z.string() }).parse(entry.item);
      mapped.push(Number(item.id));
      return [
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: item.text },
        },
      ];
    },
  });
  try {
    const windows = await source.windows(fixture, {
      head: { events: 64, bytes: 256 * 1024 },
      tail: { events: 256, bytes: 2 * 1024 * 1024 },
    });
    expect(windows.head.map((entry) => entry.index)).toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    );
    expect(windows.tail.map((entry) => entry.index)).toEqual(
      Array.from({ length: 256 }, (_, i) => i + 384),
    );
    expect(mapped).toEqual([
      ...Array.from({ length: 64 }, (_, i) => i),
      ...Array.from({ length: 256 }, (_, i) => 639 - i),
    ]);
    expect(windows.tail.at(-1)?.value).toEqual({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: items[639].text },
    });
    expect(windows.gap).toMatchObject({ startIndex: 64, endIndex: 383, count: 320 });
    expect(fixture.pages).toHaveLength(40);
    expect(fixture.pages.flat()).toHaveLength(320);
    expect(fixture.pages.every((page) => page.length === 8)).toBe(true);
  } finally {
    fixture.close();
  }
});

test.each([false, true])(
  "streams only selected message payloads with original provider positions (user-only: %s)",
  async (userMessagesOnly) => {
    const items = Array.from({ length: 40 }, (_, index) => {
      let type = "mcpToolCall";
      if (index === 2 || index === 27) type = "userMessage";
      else if (index === 3 || index === 28) type = "agentMessage";
      let text = "tool payload".repeat(6000);
      if (index === 2) text = "  café 🧪\0\n  first prompt  ";
      else if (index === 27) text = "z".repeat(300000);
      return { id: String(index), turnId: index < 20 ? "first" : "second", type, text };
    });
    const fixture = nativeHistoryFixture(items, { maxPageSize: 1 });
    const source = new CodexHistorySource({
      databasePath: fixture.databasePath,
      threadId: "thread",
      mapItem: (entry) => {
        const item = z
          .object({ id: z.string(), text: z.string(), type: z.string() })
          .parse(entry.item);
        return [
          {
            type: "timeline",
            provider: "codex",
            timestamp: "2026-10-22T00:00:00.000Z",
            item: {
              type: item.type === "userMessage" ? "user_message" : "assistant_message",
              text: item.text,
              messageId: item.id,
            },
          },
        ];
      },
    });
    try {
      const entries = [];
      for await (const entry of source.stream(fixture, { messagesOnly: true, userMessagesOnly }))
        entries.push(entry);
      const indices = userMessagesOnly ? [2, 27] : [2, 3, 27, 28];
      expect(entries.map((entry) => entry.index)).toEqual(indices);
      expect(entries.map((entry) => entry.value)).toEqual(
        indices.map((index) => ({
          type: "timeline",
          provider: "codex",
          timestamp: "2026-10-22T00:00:00.000Z",
          item: {
            type: items[index].type === "userMessage" ? "user_message" : "assistant_message",
            text: items[index].text,
            messageId: String(index),
          },
        })),
      );
      expect(fixture.pages.flat()).toEqual(indices.map(String));
      expect(fixture.pages.flat().some((id) => items[Number(id)].type === "mcpToolCall")).toBe(
        false,
      );
      expect(entries.find((entry) => entry.index === 27)?.value).toMatchObject({
        item: { text: items[27].text },
      });
    } finally {
      fixture.close();
    }
  },
);

test("streams explicit full history in provider pages without filtering tools", async () => {
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
  const stream = source.stream({ request });
  expect((await stream.next()).value?.index).toBe(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await stream.next()).value?.index).toBe(1);
  expect((await stream.next()).value?.index).toBe(2);
  expect(calls[1]).toEqual({ threadId: "thread", limit: 8, sortDirection: "asc" });
  expect(calls[2]).toEqual({ threadId: "thread", limit: 8, sortDirection: "asc", cursor: "next" });
  expect((await stream.next()).done).toBe(true);
});

test("handles short native pages and preserves attachment order within a source item", async () => {
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
    expect(seen).toEqual([0, 1, 8, 9]);
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

test.each(["before", "after"] as const)(
  "%s pages never fetch an oversized gap or cross a turn boundary",
  async (direction) => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      id: String(index),
      turnId: ["first", "second", "third"][Math.floor(index / 4)],
      text: index === 5 ? "x".repeat(100000) : String(index),
    }));
    const fixture = nativeHistoryFixture(items);
    const source = new CodexHistorySource({
      databasePath: fixture.databasePath,
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
    try {
      const page = await source.page(fixture, {
        cursor: direction === "before" ? 8 : 3,
        direction,
        limit: { events: 8, bytes: 1800 },
      });
      expect(page.entries.map((entry) => entry.index)).toEqual([3, 4, 6, 7]);
      expect(page.oversized).toEqual([
        { index: 5, bytes: Buffer.byteLength(JSON.stringify(items[5])) },
      ]);
      expect(page.nextCursor).toBe(direction === "before" ? 3 : 8);
      expect(page.coveredCount).toBe(5);
      expect(fixture.pages).toEqual(
        direction === "before" ? [["6", "7"], ["4"], ["3"]] : [["3"], ["4"], ["6", "7"]],
      );
    } finally {
      fixture.close();
    }
  },
);

test("bounds each native batch by bytes as well as item count", async () => {
  const fixture = nativeHistoryFixture(
    Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      turnId: "turn",
      text: "x".repeat(120000),
    })),
  );
  const source = new CodexHistorySource({
    databasePath: fixture.databasePath,
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
  try {
    const windows = await source.windows(fixture, {
      head: { events: 3, bytes: 512 * 1024 },
      tail: { events: 1, bytes: 1 },
    });
    expect(windows.head.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(fixture.pages).toEqual([["0", "1"], ["2"]]);
  } finally {
    fixture.close();
  }
});

test("normalizes selected batches in original head and reverse-tail priority", async () => {
  const fixture = nativeHistoryFixture(
    Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      turnId: "turn",
      text: String(index),
    })),
  );
  const mapped: string[] = [];
  const source = new CodexHistorySource({
    databasePath: fixture.databasePath,
    threadId: "thread",
    mapItem: (entry) => {
      const { id } = z.object({ id: z.string() }).parse(entry.item);
      mapped.push(id);
      return Array.from({ length: id === "0" || id === "5" ? 2 : 1 }, (_, index) => ({
        type: "timeline" as const,
        provider: "codex" as const,
        item: { type: "assistant_message" as const, text: `${id}:${index}` },
      }));
    },
  });
  try {
    const limits = { events: 3, bytes: 2000 };
    const windows = await source.windows(fixture, { head: limits, tail: limits });
    expect(windows.head.map((entry) => entry.index)).toEqual([0, 0, 1]);
    expect(windows.tail.map((entry) => entry.index)).toEqual([4, 5, 5]);
    expect(windows.gap).toMatchObject({ startIndex: 2, endIndex: 3, count: 2 });
    expect(mapped).toEqual(["0", "1", "2", "5", "4", "3"]);
    const before = await source.page(fixture, { cursor: 6, direction: "before", limit: limits });
    expect(before.entries.map((entry) => entry.index)).toEqual([4, 5, 5]);
    expect(before.nextCursor).toBe(4);
    expect(before.coveredCount).toBe(2);
    const after = await source.page(fixture, { cursor: 0, direction: "after", limit: limits });
    expect(after.entries.map((entry) => entry.index)).toEqual([0, 0, 1]);
    expect(after.nextCursor).toBe(2);
    expect(after.coveredCount).toBe(2);
  } finally {
    fixture.close();
  }
});

test.each(["before", "after"] as const)(
  "%s pages stop on normalized UTF-8 bytes without losing cursor progress",
  async (direction) => {
    const fixture = nativeHistoryFixture(
      Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        turnId: "turn",
        text: String(index),
      })),
    );
    const source = new CodexHistorySource({
      databasePath: fixture.databasePath,
      threadId: "thread",
      mapItem: () => [
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "💾".repeat(160) },
        },
      ],
    });
    try {
      const page = await source.page(fixture, {
        cursor: direction === "before" ? 6 : 0,
        direction,
        limit: { events: 3, bytes: 1000 },
      });
      expect(page.entries.map((entry) => entry.index)).toEqual([direction === "before" ? 5 : 0]);
      expect(page.nextCursor).toBe(direction === "before" ? 5 : 1);
      expect(page.coveredCount).toBe(1);
      expect(page.oversized).toEqual([]);
      expect(page.entries[0].bytes).toBeLessThan(1000);
    } finally {
      fixture.close();
    }
  },
);

test.each(["changed-anchor", "extra-item", "empty-page"] as const)(
  "refuses a native %s instead of returning a mixed history window",
  async (failure) => {
    const fixture = nativeHistoryFixture(
      Array.from({ length: 3 }, (_, index) => ({
        id: String(index),
        turnId: "turn",
        text: String(index),
      })),
    );
    const source = new CodexHistorySource({
      databasePath: fixture.databasePath,
      threadId: "thread",
      mapItem: () => [],
    });
    const request = async (method: string, params: unknown) => {
      const result = await fixture.request(method, params);
      if (method !== "thread/items/list") return result;
      const data = result.data;
      if (failure === "changed-anchor") data[1].item.id = "changed";
      if (failure === "extra-item") data.push(data[0]);
      if (failure === "empty-page") data.length = 0;
      return result;
    };
    try {
      await expect(
        source.windows(
          { request },
          {
            head: { events: 3, bytes: 2000 },
            tail: { events: 1, bytes: 1 },
          },
        ),
      ).rejects.toThrow("Native history changed while reading its bounded window");
    } finally {
      fixture.close();
    }
  },
);

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
