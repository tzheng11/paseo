import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { selectReferenceProjectedTimelinePage } from "./test-utils/timeline-page-reference.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskAgentTimelineStore } from "./disk-agent-timeline-store.js";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

function projectedStart(row: { seqStart: number }): number {
  return row.seqStart;
}

describe.each(["memory", "disk"])("%s agent timeline store", (backend) => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });
  async function createStore() {
    if (backend === "memory") return new InMemoryAgentTimelineStore();
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-contract-"));
    const store = await DiskAgentTimelineStore.create({ directory, cacheBytes: 1024 });
    cleanups.push(
      () => rmSync(directory, { recursive: true, force: true }),
      () => store.close(),
    );
    return store;
  }
  it("resets stale forward cursors to complete available turns", async () => {
    const store = await createStore();
    store.initialize("agent", { epoch: "current" });
    for (let index = 0; index < 60; index++)
      store.append(
        "agent",
        {
          type: "tool_call",
          callId: `call-${index}`,
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
        { turnId: "run" },
      );
    const page = store.fetch("agent", {
      direction: "after",
      cursor: { epoch: "old", seq: 10 },
      limit: 40,
      wholeTurns: true,
    });
    expect(page.rows).toHaveLength(60);
    expect(page).toMatchObject({
      reset: true,
      staleCursor: true,
      startSeq: 1,
      endSeq: 60,
      hasOlder: false,
      hasNewer: false,
    });
  });

  it("expands both edges of before pages using canonical turns and old tool coverage", async () => {
    const store = await createStore();
    store.initialize("turns", { epoch: "e" });
    const tool = {
      type: "tool_call" as const,
      callId: "early",
      name: "shell",
      status: "running" as const,
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("turns", { type: "user_message", text: "first" }, { turnId: "a" });
    store.append("turns", tool, { turnId: "a" });
    store.append("turns", { type: "user_message", text: "steered" }, { turnId: "a" });
    store.append("turns", { type: "assistant_message", text: "A" }, { turnId: "a" });
    store.append("turns", { ...tool, callId: "heartbeat", name: "heartbeat" }, { turnId: "b" });
    store.append("turns", { type: "assistant_message", text: "B" }, { turnId: "b" });
    store.append("turns", { type: "user_message", text: "third" }, { turnId: "c" });
    const options = {
      direction: "before" as const,
      cursor: { epoch: "e", seq: 6 },
      limit: 2,
      wholeTurns: true,
    };
    const before = store.fetch("turns", options);
    expect(before.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(before).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false, hasNewer: true });
    expect(await store.fetchAsync("turns", options)).toEqual(before);
    store.append("turns", { ...tool, status: "completed" }, { turnId: "a" });
    const tail = store.fetch("turns", { limit: 1, wholeTurns: true });
    expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(tail).toMatchObject({ startSeq: 1, endSeq: 8, hasOlder: false, hasNewer: false });
    expect(await store.fetchAsync("turns", { limit: 1, wholeTurns: true })).toEqual(tail);
  });

  it("clamps an overshooting before cursor into the bounded tail window", async () => {
    const store = await createStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", async () => {
    const store = await createStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  describe("projected timeline retention", () => {
    it("retains one full tool state while streaming every source update", async () => {
      const store = await createStore();
      store.initialize("agent");
      for (let seq = 1; seq <= 2000; seq++) {
        const item = {
          type: "tool_call" as const,
          callId: "child",
          name: "task",
          status: "running" as const,
          error: null,
          detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
        };
        expect(store.append("agent", item)).toMatchObject({ seq, item });
      }
      const result = store.fetch("agent", { limit: 0 });
      expect(result.rows).toHaveLength(1);
      expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
      expect(result.window.maxSeq).toBe(2000);
    });

    it("catches up a mid-message cursor with the complete projected message", async () => {
      const store = await createStore();
      store.initialize("agent", { epoch: "e" });
      store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
      store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
      expect(
        store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
      ).toMatchObject([
        {
          item: { text: "AB" },
          seqStart: 1,
          seqEnd: 2,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
        },
      ]);
    });
  });

  describe("projected sequence ownership", () => {
    it("preserves fetched coverage when another source chunk arrives", async () => {
      const store = await createStore();
      store.initialize("a");
      store.append("a", { type: "assistant_message", text: "A" });
      const before = store.fetch("a");
      store.append("a", { type: "assistant_message", text: "B" });
      expect(before.rows[0]).toMatchObject({
        item: { text: "A" },
        seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
      });
      expect(store.fetch("a").rows[0]).toMatchObject({
        item: { text: "AB" },
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      });
    });
    it("preserves source positions when seeding a projected history whose last update is an earlier tool", async () => {
      const store = await createStore();
      store.initialize("a");
      const tool = {
        type: "tool_call" as const,
        callId: "t",
        name: "shell",
        error: null,
        detail: { type: "plain_text" as const, label: "work" },
      };
      store.append("a", { ...tool, status: "running" });
      store.append("a", { type: "assistant_message", text: "Answer" });
      store.append("a", { ...tool, status: "completed" });
      store.initialize("b", { rows: store.getRows("a") });
      expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
      expect(store.fetch("b").rows.map(projectedStart)).toEqual([1, 2, 4]);
    });
    it("returns the last projected assistant message without joining different messages", async () => {
      const store = await createStore();
      store.initialize("a");
      store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
      store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
      store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
      expect(store.getLastAssistantMessage("a")).toBe("Second");
    });

    it("includes transitive tool updates in a contiguous projected tail", async () => {
      const store = await createStore();
      store.initialize("a");
      const tool = (callId: string, status: "running" | "completed") => ({
        type: "tool_call" as const,
        callId,
        name: "shell",
        status,
        error: null,
        detail: { type: "plain_text" as const, label: "work" },
      });
      store.append("a", tool("first", "running"));
      store.append("a", tool("second", "running"));
      store.append("a", { type: "user_message", text: "Continue" });
      store.append("a", tool("first", "completed"));
      store.append("a", { type: "assistant_message", text: "Answer" });
      store.append("a", tool("second", "completed"));
      const tail = store.fetch("a", { limit: 1 });
      expect(tail.rows.map(projectedStart)).toEqual([1, 2, 3, 5]);
      expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
    });
  });
});

describe("timeline read allocation budget", () => {
  it("counts retained items without reading historical payloads", async () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    let payloadReads = 0;
    for (let i = 0; i < 1000; i++) {
      store.append("a", {
        get type() {
          payloadReads++;
          return "user_message" as const;
        },
        text: `message ${i}`,
      });
    }
    payloadReads = 0;
    expect(store.getCount("a")).toBe(1000);
    expect(payloadReads).toBe(0);
  });
  it("preserves source positions when seeding a projected history whose last update is an earlier tool", async () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("a", { ...tool, status: "running" });
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", { ...tool, status: "completed" });
    store.initialize("b", { rows: store.getRows("a") });
    expect(store.getLastItem("b")).toMatchObject({ type: "tool_call", status: "completed" });
    expect(store.getLastAssistantMessage("b")).toBe("Answer");
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
    expect(store.getLastItem("b")).toEqual({ type: "user_message", text: "next" });
    expect(store.fetch("b").rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });
  it("returns the last projected assistant message without joining different messages", async () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect(store.getLastAssistantMessage("a")).toBe("Second");
  });
});

describe("projected payload selection", () => {
  it("pages an already projected history without inspecting unselected payloads", async () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    let payloadReads = 0;
    for (let i = 0; i < 1000; i++) {
      store.append("a", {
        get type() {
          payloadReads++;
          return "user_message" as const;
        },
        text: `message ${i}`,
      });
    }
    payloadReads = 0;
    const result = store.fetch("a", { limit: 10 });
    expect(payloadReads).toBe(0);
    expect(result.rows.map((row) => row.item)).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ type: "user_message", text: `message ${990 + i}` })),
    );
    expect(result).toMatchObject({ startSeq: 991, endSeq: 1000, hasOlder: true });
    // A caller must not be able to overwrite the retained row metadata.
    result.rows[0].seqStart = -1;
    expect(store.fetch("a", { limit: 10 }).rows[0].seqStart).toBe(991);
  });
});

it.each([false, true])(
  "serves tail 200 from 100,000 retained rows without stalling the loop (wholeTurns=%s)",
  async (wholeTurns) => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("large");
    for (let index = 0; index < 100_000; index++) {
      store.append("large", { type: "user_message", text: String(index) });
    }
    const { result: tail, blockingMs } = await measureMainThreadWork(
      `timeline tail main-thread work (wholeTurns=${wholeTurns})`,
      () => {
        let page = store.fetch("large", { limit: 200, wholeTurns });
        for (let repeat = 1; repeat < 8; repeat++)
          page = store.fetch("large", { limit: 200, wholeTurns });
        return page;
      },
    );
    expect(tail.rows).toHaveLength(200);
    expect(tail.startSeq).toBe(99_801);
    expect(tail.endSeq).toBe(100_000);
    expect(blockingMs).toBeLessThan(50);
  },
);

it("matches the previous reprojecting selector on seeded randomized timelines", async () => {
  let seed = 0x76aabbcc;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * bound);
  };
  for (let scenario = 0; scenario < 100; scenario++) {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a", { epoch: "e" });
    for (let seq = 1; seq <= 100; seq++) {
      const identity = String(random(8));
      const text = String(seq);
      const items: AgentTimelineItem[] = [
        { type: "user_message", text },
        { type: "assistant_message", text },
        { type: "assistant_message", text, messageId: identity },
        { type: "reasoning", text },
        {
          type: "tool_call",
          callId: identity,
          name: "shell",
          status: "running",
          error: null,
          detail: { type: "plain_text", label: text },
        },
        {
          type: "plugin",
          id: identity,
          pluginId: "test",
          kind: "state",
          version: 1,
          data: { text },
        },
      ];
      store.append("a", items[random(items.length)], { turnId: String(random(3)) });
    }
    // Include rehydration of already-projected rows, with non-monotonic seqEnd.
    store.initialize("b", { rows: store.getRows("a"), epoch: "e" });
    for (const agentId of ["a", "b"]) {
      assertSelectionMatchesReference(store, agentId);
      store.append(agentId, { type: "assistant_message", text: "later" });
      assertSelectionMatchesReference(store, agentId);
    }
  }
});

function assertSelectionMatchesReference(store: InMemoryAgentTimelineStore, agentId: string): void {
  for (const direction of ["tail", "before", "after"] as const) {
    for (const limit of [0, 1, 7, 200]) {
      for (const cursorSeq of [0, 1, 25, 50, 99, 100, 150]) {
        const actual = store.fetch(agentId, {
          direction,
          limit,
          cursor: { epoch: "e", seq: cursorSeq },
        });
        const expected = selectReferenceProjectedTimelinePage({
          rows: store.getRows(agentId),
          bounds: actual.window,
          direction,
          limit,
          cursorSeq,
        });
        expect({
          ...expected,
          entries: undefined,
          rows: expected.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
        }).toEqual({
          entries: undefined,
          rows: actual.rows,
          startSeq: actual.startSeq,
          endSeq: actual.endSeq,
          hasOlder: actual.hasOlder,
          hasNewer: actual.hasNewer,
        });
      }
    }
  }
}

it("continues a scroll across appends and lifecycle collapse without losing source coverage", async () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a", { epoch: "e" });
  const tool: AgentTimelineItem = {
    type: "tool_call",
    callId: "t",
    name: "shell",
    status: "running",
    error: null,
    detail: { type: "plain_text", label: "work" },
  };
  store.append("a", tool);
  for (let seq = 2; seq <= 5; seq++) store.append("a", { type: "user_message", text: String(seq) });
  const first = store.fetch("a", { direction: "after", cursor: { epoch: "e", seq: 0 }, limit: 2 });
  expect(first.endSeq).toBe(2);
  store.append("a", { ...tool, status: "completed" });
  store.append("a", { type: "assistant_message", text: "Done" });
  expect(first.rows[0].item).toMatchObject({ status: "running" });
  const second = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: first.endSeq! },
    limit: 2,
  });
  expect(second.rows.map((row) => row.seqStart)).toEqual([3, 4]);
  expect(second.endSeq).toBe(4);
  const third = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: second.endSeq! },
    limit: 2,
  });
  expect(third.rows.map((row) => row.seqStart)).toEqual([1, 5]);
  expect(third.rows[0].item).toMatchObject({ status: "completed" });
  expect(third.endSeq).toBe(6);
  const last = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: third.endSeq! },
    limit: 2,
  });
  expect(last.rows.map((row) => row.item)).toEqual([{ type: "assistant_message", text: "Done" }]);
  expect(last.endSeq).toBe(7);
  expect(last.hasNewer).toBe(false);
});
