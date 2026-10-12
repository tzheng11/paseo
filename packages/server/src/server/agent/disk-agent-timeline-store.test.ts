import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { DiskAgentTimelineStore } from "./disk-agent-timeline-store.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});
function createStore(cacheBytes = 1024) {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-test-"));
  const store = new DiskAgentTimelineStore({ directory, cacheBytes });
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => store.close(),
  );
  return store;
}
const tool = (callId: string, status: "running" | "completed"): AgentTimelineItem => ({
  type: "tool_call",
  callId,
  status,
  name: "shell",
  error: null,
  detail: { type: "plain_text", label: "work" },
});

describe("DiskAgentTimelineStore", () => {
  it("cleans caches left by a dead process without touching live or unrelated directories", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-owner-test-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(path.join(directory, "timeline-2147483647-dead"));
    mkdirSync(path.join(directory, `timeline-${process.pid}-live`));
    mkdirSync(path.join(directory, "timeline-unrelated"));
    const store = new DiskAgentTimelineStore({ directory });
    cleanups.push(() => store.close());
    expect(readdirSync(directory)).not.toContain("timeline-2147483647-dead");
    expect(readdirSync(directory)).toContain(`timeline-${process.pid}-live`);
    expect(readdirSync(directory)).toContain("timeline-unrelated");
  });

  it("preserves empty-window cursor semantics", () => {
    const disk = createStore();
    const memory = new InMemoryAgentTimelineStore();
    disk.initialize("a", { epoch: "epoch" });
    memory.initialize("a", { epoch: "epoch" });
    for (const direction of ["tail", "before", "after"] as const)
      expect(disk.fetch("a", { direction })).toEqual(memory.fetch("a", { direction }));
  });

  it("appends batches with exactly the same projection as individual source events", () => {
    const disk = createStore();
    const memory = new InMemoryAgentTimelineStore();
    disk.initialize("a", { epoch: "epoch" });
    memory.initialize("a", { epoch: "epoch" });
    const entries = [
      tool("t", "running"),
      { type: "assistant_message" as const, text: "Hel" },
      { type: "assistant_message" as const, text: "lo" },
      tool("t", "completed"),
    ].map((item) => ({ item, timestamp: "now" }));
    expect(disk.appendBatch("a", entries)).toEqual(memory.appendBatch("a", entries));
    expect(disk.fetch("a")).toEqual(memory.fetch("a"));
  });
  it("matches memory-store paging with interleaved lifecycle updates and evicted rows", () => {
    const disk = createStore();
    const memory = new InMemoryAgentTimelineStore();
    for (const store of [disk, memory]) {
      store.initialize("a", { epoch: "epoch" });
      const events: AgentTimelineItem[] = [
        tool("first", "running"),
        tool("second", "running"),
        { type: "user_message", text: "Continue", clientMessageId: "user" },
        tool("first", "completed"),
        { type: "assistant_message", text: "Answer", messageId: "reply" },
        tool("second", "completed"),
      ];
      for (const item of events) store.append("a", item, { timestamp: "2026-10-10" });
    }
    for (const direction of ["tail", "before", "after"] as const) {
      for (const seq of [0, 1, 2, 3, 4, 5, 6, 100]) {
        for (const limit of [0, 1, 2, 200]) {
          const options = { direction, limit, cursor: { epoch: "epoch", seq } };
          expect(disk.fetch("a", options)).toEqual(memory.fetch("a", options));
        }
      }
    }
    expect(disk.fetch("a", { cursor: { epoch: "old", seq: 3 } })).toEqual(
      memory.fetch("a", { cursor: { epoch: "old", seq: 3 } }),
    );
    expect(disk.getSubmittedUserMessage("a", "user")).toEqual(
      memory.getSubmittedUserMessage("a", "user"),
    );
    expect(disk.enrichSubmittedUserMessage("a", "user", "provider")).toEqual(
      memory.enrichSubmittedUserMessage("a", "user", "provider"),
    );
    expect(disk.getRows("a")).toEqual(memory.getRows("a"));
    expect(disk.getLastItem("a")).toEqual(memory.getLastItem("a"));
    expect(disk.getRecentItems("a", 1)).toEqual(memory.getRecentItems("a", 1));
    expect(disk.getRecentItems("a", 1)).toHaveLength(1);
    expect(disk.getRecentItems("a", 0)).toEqual(memory.getItems("a"));
  });

  it("shares a bounded cache across agents while preserving complete older history", () => {
    const disk = createStore(4096);
    for (const agent of ["a", "b", "c"]) {
      disk.initialize(agent);
      for (let index = 0; index < 200; index++) {
        disk.append(agent, { type: "user_message", text: `${index}:${"x".repeat(1024)}` });
      }
    }
    expect(disk.cachedBytes).toBeLessThanOrEqual(4096);
    expect(disk.getCount("a")).toBe(200);
    const epoch = disk.getEpoch("a");
    let cursor = 201;
    const seen: number[] = [];
    do {
      const page = disk.fetch("a", {
        direction: "before",
        cursor: { epoch, seq: cursor },
        limit: 7,
      });
      seen.push(...page.rows.map((row) => row.seqStart));
      if (!page.hasOlder) break;
      cursor = page.startSeq!;
    } while (cursor > 0);
    expect(seen.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    expect(disk.cachedBytes).toBeLessThanOrEqual(4096);
  });

  it("keeps seeded coverage, merges chunks, and isolates deletion and reinitialization", () => {
    const disk = createStore();
    disk.initialize("a", {
      nextSeq: 5,
      rows: [
        {
          seq: 5,
          timestamp: "now",
          item: { type: "assistant_message", text: "Hel", messageId: "m" },
        },
      ],
    });
    disk.append("a", { type: "assistant_message", text: "lo", messageId: "m" });
    expect(disk.getCount("a")).toBe(1);
    expect(disk.getLastAssistantMessage("a")).toBe("Hello");
    disk.initialize("b", { rows: disk.getRows("a") });
    expect(disk.append("b", { type: "user_message", text: "next" }).seq).toBe(7);
    expect(
      disk.fetch("a", { direction: "after", cursor: { epoch: disk.getEpoch("a"), seq: 1 } }),
    ).toMatchObject({ gap: true, reset: true });
    disk.delete("a");
    expect(disk.has("a")).toBe(false);
    expect(disk.getCount("b")).toBe(2);
    disk.initialize("a");
    expect(disk.getItems("a")).toEqual([]);
    expect(disk.append("a", { type: "user_message", text: "fresh" }).seq).toBe(1);
  });
});
