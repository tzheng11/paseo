import { describe, expect, it } from "vitest";
import { AgentHistoryReplay } from "./agent-history-replay.js";

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
