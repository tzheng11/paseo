import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { readCodexHistoryIndex } from "./history-index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(encoding: "UTF-8" | "UTF-16le" = "UTF-8") {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-history-index-test-"));
  directories.push(directory);
  const databasePath = path.join(directory, "history.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA encoding = '${encoding}'`);
  db.exec(`CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    updated_at_ordinal INTEGER, item_type TEXT, item_json TEXT
  ); CREATE INDEX history_order ON thread_items(thread_id, rollout_ordinal);`);
  const insert = db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (let index = 0; index < 10; index++)
    insert.run(
      "thread",
      "turn",
      String(index),
      index * 3 + 1,
      index * 3 + 1,
      index === 0 ? "userMessage" : "agentMessage",
      index === 5 ? "x".repeat(100000) : "🧠".repeat(10),
    );
  // A peer's huge payload must not appear in this thread's totals or references.
  insert.run("peer", "other", "private-peer", 100, 100, "agentMessage", "x".repeat(100000));
  db.close();
  return { databasePath, threadId: "thread" };
}

test("reads only bounded metadata for head and tail, preserving the middle's exact size", async () => {
  const source = fixture();
  const result = await readCodexHistoryIndex({
    ...source,
    operation: "windows",
    retainedItemIds: ["0", "9", "gone"],
    head: { events: 2, bytes: 1000 },
    tail: { events: 3, bytes: 1000 },
  });
  expect(result.totalEvents).toBe(10);
  expect(result.totalBytes).toBe(100360);
  expect(result.head?.map((row) => row.index)).toEqual([0, 1]);
  expect(result.tail?.map((row) => row.index)).toEqual([8, 9]);
  expect(result.head?.[1].previousItemId).toBe("0");
  expect(result.gap).toEqual({ startIndex: 2, endIndex: 7, count: 6, bytes: 100200 });
  expect(result.userMessages).toEqual([{ messageId: "0", turnId: "turn" }]);
  expect(result.asyncQuestionIds).toEqual(["0", "9"]);
  expect(result.payloadsDecoded).toBe(0);
  // Payloads are deliberately invalid JSON: even the selected edges were not parsed.
  expect(JSON.stringify(result)).not.toContain("🧠");
});

test("pages around an oversized record without decoding it or losing cursor progress", async () => {
  const source = fixture();
  const page = await readCodexHistoryIndex({
    ...source,
    operation: "page",
    cursor: 5,
    direction: "after",
    limit: { events: 2, bytes: 1000 },
  });
  expect(page.entries?.map((row) => row.index)).toEqual([6]);
  expect(page.oversized).toEqual([{ index: 5, bytes: 100000 }]);
  expect(page.nextCursor).toBe(7);
  const before = await readCodexHistoryIndex({
    ...source,
    operation: "page",
    cursor: 7,
    direction: "before",
    limit: { events: 2, bytes: 1000 },
  });
  expect(before.entries?.map((row) => row.index)).toEqual([6]);
  expect(before.oversized).toEqual([{ index: 5, bytes: 100000 }]);
  expect(before.nextCursor).toBe(5);
  await expect(
    readCodexHistoryIndex({
      ...source,
      operation: "page",
      cursor: 11,
      direction: "after",
      limit: { events: 2, bytes: 1000 },
    }),
  ).rejects.toThrow("RangeError");
});

test.each(["UTF-8", "UTF-16le"] as const)(
  "preserves exact byte budgets for Unicode and embedded NULs in %s history",
  async (encoding) => {
    const source = fixture(encoding);
    const payload = "é🧪\0".repeat(20000);
    const payloadBytes = Buffer.byteLength(payload, encoding === "UTF-8" ? "utf8" : "utf16le");
    const db = new DatabaseSync(source.databasePath);
    db.prepare("UPDATE thread_items SET item_json = ? WHERE thread_id = ? AND item_id = ?").run(
      payload,
      source.threadId,
      "5",
    );
    db.close();

    const result = await readCodexHistoryIndex({
      ...source,
      operation: "windows",
      head: { events: 2, bytes: 1000 },
      tail: { events: 2, bytes: 1000 },
    });
    expect(result.totalEvents).toBe(10);
    expect(result.totalBytes).toBe(payloadBytes + 360);
    expect(result.gap).toEqual({
      startIndex: 2,
      endIndex: 7,
      count: 6,
      bytes: payloadBytes + 200,
    });
    expect(result.payloadsDecoded).toBe(0);

    const page = await readCodexHistoryIndex({
      ...source,
      operation: "page",
      cursor: 5,
      direction: "after",
      limit: { events: 2, bytes: 1000 },
    });
    expect(page.oversized).toEqual([{ index: 5, bytes: payloadBytes }]);
    expect(page.entries?.map((row) => row.index)).toEqual([6]);
    expect(page.nextCursor).toBe(7);
  },
);

test.each([false, true])(
  "selects message metadata in one ordered pass with global positions and tool anchors (user-only: %s)",
  async (userOnly) => {
    const source = fixture();
    const db = new DatabaseSync(source.databasePath);
    db.exec("DELETE FROM thread_items WHERE thread_id = 'thread'");
    const insert = db.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
    const types = [
      "mcpToolCall",
      "userMessage",
      "agentMessage",
      "mcpToolCall",
      "mcpToolCall",
      "userMessage",
      "agentMessage",
    ];
    const turns = ["first", "first", "first", "second", "first", "first", "second"];
    for (const [index, type] of types.entries())
      insert.run(
        "thread",
        turns[index],
        String(index),
        index * 3 + 1,
        index * 3 + 1,
        type,
        index === 4 ? "invalid JSON".repeat(10000) : "🧪\0",
      );
    db.close();
    const result = await readCodexHistoryIndex({ ...source, operation: "messages", userOnly });
    const expected = userOnly ? [1, 5] : [1, 2, 5, 6];
    expect(result.messages?.map((ref) => ref.index)).toEqual(expected);
    expect(result.messages?.map((ref) => ref.previousItemId)).toEqual(
      userOnly ? ["0", "4"] : ["0", "1", "4", "3"],
    );
    expect(result.messages?.map((ref) => ref.ordinal)).toEqual(
      expected.map((index) => index * 3 + 1),
    );
    expect(result.messages?.map((ref) => ref.messageType)).toEqual(
      expected.map((index) => types[index]),
    );
    expect(result.totalEvents).toBe(7);
    expect(result.payloadsDecoded).toBe(0);
    expect(JSON.stringify(result)).not.toContain("invalid JSON");
  },
);
