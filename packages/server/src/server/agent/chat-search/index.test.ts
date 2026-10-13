import { expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { searchTimeline } from "./index.js";

it("keeps provider positions separate from compact stream sequences", async () => {
  async function* source() {
    yield {
      seq: 101,
      historyIndex: 100,
      timestamp: "start",
      item: { type: "user_message" as const, text: "middle target" },
    };
  }
  expect(await searchTimeline({ rows: source(), query: "target" })).toEqual({
    locations: [{ seq: 101, historyIndex: 100, role: "user", count: 1 }],
    nextCursor: null,
  });
});

function rows(items: AgentTimelineItem[]) {
  return items.map((item, index) => ({ item, seq: index + 1, timestamp: "2026-09-12T00:00:00Z" }));
}

it("searches a streamed history and closes it when the result page fills", async () => {
  let read = 0,
    closed = false;
  async function* source() {
    try {
      for (let index = 1; index <= 1000; index++) {
        read++;
        yield {
          item: { type: "user_message" as const, text: "target" },
          seq: index,
          timestamp: "now",
        };
      }
    } finally {
      closed = true;
    }
  }
  expect(await searchTimeline({ rows: source(), query: "target" })).toEqual({
    locations: Array.from({ length: 200 }, (_, index) => ({
      seq: index + 1,
      role: "user",
      count: 1,
    })),
    nextCursor: 200,
  });
  expect(read).toBe(201);
  expect(closed).toBe(true);
});

it("returns source locations for formatted assistant text and literal user text", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "user_message", text: "hello **world**" },
      { type: "assistant_message", text: "İ😀hello **world** and hello *world*" },
      {
        type: "assistant_message",
        text: "[hello &amp; world](https://example.com)",
        messageId: "separate",
      },
    ]),
    query: "hello world",
  });
  expect(result).toEqual({
    locations: [{ seq: 2, role: "assistant", count: 2 }],
    nextCursor: null,
  });
});

it("finds code and literal punctuation without searching tools, reasoning, or task state", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "assistant_message", text: "```ts\nconst value = 'a.b';\n```" },
      { type: "reasoning", text: "a.b" },
      { type: "todo", items: [{ text: "a.b", completed: false }] },
      { type: "user_message", text: "axb" },
      { type: "user_message", text: "a.b" },
    ]),
    query: "a.b",
  });
  expect(result.locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
    { seq: 5, role: "user", count: 1 },
  ]);
});

it("bounds results and resumes without losing locations", async () => {
  const source = rows(
    Array.from({ length: 202 }, () => ({ type: "user_message", text: "target" })),
  );
  const first = await searchTimeline({ rows: source, query: "target" });
  expect(first.locations).toHaveLength(200);
  expect(first.nextCursor).toBe(200);
  const second = await searchTimeline({ rows: source, query: "target", cursor: first.nextCursor! });
  expect(second).toEqual({
    locations: [
      { seq: 201, role: "user", count: 1 },
      { seq: 202, role: "user", count: 1 },
    ],
    nextCursor: null,
  });
});

it("finds ordinary Markdown entities and line breaks without requiring identical parsers", async () => {
  const source = rows([{ type: "assistant_message", text: "hello &amp; **world**\nnext line" }]);
  expect((await searchTimeline({ rows: source, query: "hello & world" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "world next" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
});

it("counts occurrences per rendered block rather than across block boundaries", async () => {
  const source = rows([
    { type: "assistant_message", text: "target one\n\ntarget two\n\n- target three\n- end target" },
    { type: "user_message", text: "TARGET target" },
  ]);
  expect((await searchTimeline({ rows: source, query: "target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 4 },
    { seq: 2, role: "user", count: 2 },
  ]);
  expect((await searchTimeline({ rows: source, query: "end target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "two target" })).locations).toEqual([]);
  // Rendered text never runs from the end of one block into the start of the next, so
  // neither does a match, however contiguous the Markdown source looks.
  expect((await searchTimeline({ rows: source, query: "one target" })).locations).toEqual([]);
});
