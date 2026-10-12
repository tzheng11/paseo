import { describe, expect, it } from "vitest";
import {
  AgentHistoryReplay,
  withAgentHistoryReadMetrics,
  type AgentHistoryReadMetrics,
} from "./agent-history-replay.js";

describe("AgentHistoryReplay", () => {
  it("replays a large streamed history twice without consuming the source twice", async () => {
    let produced = 0;
    async function* source() {
      for (let index = 0; index < 1000; index++) {
        produced++;
        yield { index, text: "x".repeat(1024) };
      }
    }
    const replay = await AgentHistoryReplay.create(source());
    try {
      for (let pass = 0; pass < 2; pass++) {
        let count = 0;
        for await (const event of replay.events()) {
          expect(event).toEqual({ index: count++, text: "x".repeat(1024) });
        }
        expect(count).toBe(1000);
      }
      expect(produced).toBe(1000);
    } finally {
      await replay.close();
    }
  });

  it("applies bounded synchronous reads without splitting Unicode across chunks", async () => {
    const events = [
      { text: "x".repeat(65520) + "🧠🌍", index: 1 },
      { text: "next", index: 2 },
    ];
    const replay = await AgentHistoryReplay.create(events);
    try {
      expect([...replay.eventsSync()]).toEqual(events);
    } finally {
      await replay.close();
    }
  });

  it("rejects a partial source instead of publishing a partial replay", async () => {
    async function* source() {
      yield "first";
      throw new Error("interrupted");
    }
    await expect(AgentHistoryReplay.create(source())).rejects.toThrow("interrupted");
  });
});

describe("request-scoped history read metrics", () => {
  function metrics(): AgentHistoryReadMetrics {
    return { historyEventsRead: 0, historyBytesRead: 0, historyReplayCount: 0 };
  }

  it("counts each staged source event once, in UTF-8 bytes, without counting replay passes", async () => {
    const measured = metrics();
    const events = [{ text: "🧠" }, { text: "next" }];
    await withAgentHistoryReadMetrics(measured, async () => {
      const replay = await AgentHistoryReplay.create(events);
      try {
        for (let pass = 0; pass < 2; pass++) {
          for await (const _event of replay.events()) {
          }
        }
      } finally {
        await replay.close();
      }
    });
    expect(measured).toEqual({
      historyEventsRead: 2,
      historyBytesRead: events.reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event) + "\n"),
        0,
      ),
      historyReplayCount: 1,
    });
  });

  it("keeps overlapping callers separate and records partial reads on failure", async () => {
    const first = metrics(),
      second = metrics();
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    async function* failingSource() {
      yield { caller: "first" };
      await barrier;
      throw new Error("provider stopped");
    }
    const pending = withAgentHistoryReadMetrics(first, () =>
      AgentHistoryReplay.create(failingSource()),
    );
    const rejected = expect(pending).rejects.toThrow("provider stopped");
    await withAgentHistoryReadMetrics(second, async () => {
      const replay = await AgentHistoryReplay.create([{ caller: "second" }, { caller: "second" }]);
      await replay.close();
    });
    release();
    await rejected;
    expect(first).toEqual({
      historyEventsRead: 1,
      historyBytesRead: Buffer.byteLength('{"caller":"first"}\n'),
      historyReplayCount: 1,
    });
    expect(second).toEqual({
      historyEventsRead: 2,
      historyBytesRead: 2 * Buffer.byteLength('{"caller":"second"}\n'),
      historyReplayCount: 1,
    });
    const unrelated = await AgentHistoryReplay.create([{ caller: "unrelated" }]);
    await unrelated.close();
    expect(first.historyEventsRead).toBe(1);
    expect(second.historyEventsRead).toBe(2);
  });
});
