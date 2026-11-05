import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  AgentHistoryReplay,
  withAgentHistoryReadMetrics,
  type AgentHistoryReadMetrics,
} from "./agent-history-replay.js";

describe("AgentHistoryReplay", () => {
  it("retries abandoned cache pruning after a transient filesystem failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-prune-retry-test-"));
    const target = path.join(root, "temporary-root");
    // Node uses TEMP on Windows and TMPDIR on POSIX.
    const temporaryRootVariable = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const previous = process.env[temporaryRootVariable];
    await writeFile(target, "temporarily not a directory");
    process.env[temporaryRootVariable] = target;
    try {
      await expect(AgentHistoryReplay.create([])).rejects.toMatchObject({ code: "ENOTDIR" });
      await rm(target);
      await mkdir(target);
      const replay = await AgentHistoryReplay.create(["recovered"]);
      try {
        expect(await Array.fromAsync(replay.events())).toEqual(["recovered"]);
      } finally {
        await replay.close();
      }
    } finally {
      if (previous === undefined) delete process.env[temporaryRootVariable];
      else process.env[temporaryRootVariable] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("replaces keyed payloads on disk without moving their original history position", async () => {
    const replay = await AgentHistoryReplay.create(
      [
        { id: "tool", state: "running" },
        { id: "message", state: "answer" },
        { id: "tool", state: "completed" },
      ],
      { key: (value) => value.id },
    );
    try {
      const values: Array<{ id: string; state: string }> = [];
      for await (const value of replay.streamAll()) values.push(value);
      expect(values).toEqual([
        { id: "tool", state: "completed" },
        { id: "message", state: "answer" },
      ]);
      expect(await Array.fromAsync(replay.events())).toEqual(values);
      const windows = await replay.readWindows({
        head: { events: 1, bytes: 100 },
        tail: { events: 1, bytes: 100 },
      });
      expect(windows.gap).toBeNull();
      expect(windows.totalBytes).toBe(
        values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value) + "\n"), 0),
      );
    } finally {
      await replay.close();
    }
  });
  it("indexes a frozen file without decoding its omitted middle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "history-window-test-"));
    const file = path.join(directory, "source.jsonl");
    // An invalid middle proves indexing and edge reads do not decode it.
    const middle = "not JSON".repeat(100000);
    await writeFile(
      file,
      JSON.stringify({ text: "first 🧠" }) +
        "\n" +
        middle +
        "\n" +
        JSON.stringify({ text: "last 🌍" }),
    );
    const replay = await AgentHistoryReplay.openJsonl<{ text: string }>(file);
    try {
      await writeFile(file, "rewound source");
      const windows = await replay.readWindows({
        head: { events: 1, bytes: 100 },
        tail: { events: 1, bytes: 100 },
      });
      expect(windows.head[0].value.text).toBe("first 🧠");
      expect(windows.tail[0].value.text).toBe("last 🌍");
      expect(windows.gap).toEqual({
        startIndex: 1,
        endIndex: 1,
        count: 1,
        bytes: Buffer.byteLength(middle + "\n"),
      });
      await expect(
        replay.readPage({ cursor: 1, direction: "after", limit: { events: 1, bytes: 1000000 } }),
      ).rejects.toThrow();
    } finally {
      await replay.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("loads bounded head and tail windows and reports the exact middle count and bytes", async () => {
    const values = Array.from({ length: 100 }, (_, index) => ({
      index,
      text: "🧠".repeat(index + 1),
    }));
    const replay = await AgentHistoryReplay.create(values);
    const size = (index: number) => Buffer.byteLength(JSON.stringify(values[index]) + "\n");
    try {
      const window = await replay.readWindows({
        head: { events: 5, bytes: size(0) + size(1) },
        tail: { events: 3, bytes: 10000 },
      });
      expect(window.head.map((entry) => entry.value)).toEqual(values.slice(0, 2));
      expect(window.tail.map((entry) => entry.value)).toEqual(values.slice(97));
      expect(window.gap).toEqual({
        startIndex: 2,
        endIndex: 96,
        count: 95,
        bytes: values
          .slice(2, 97)
          .reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value) + "\n"), 0),
      });
      expect(window.totalEvents).toBe(100);
      expect(window.totalBytes).toBe(
        values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value) + "\n"), 0),
      );
    } finally {
      await replay.close();
    }
  });

  it("keeps oversized records out of both windows and pages and advances their cursors", async () => {
    const values = [{ text: "start" }, { text: "x".repeat(1024 * 1024) }, { text: "end" }];
    const replay = await AgentHistoryReplay.create(values);
    try {
      const windows = await replay.readWindows({
        head: { events: 50, bytes: 100 },
        tail: { events: 50, bytes: 100 },
      });
      expect(windows.head.map((entry) => entry.index)).toEqual([0]);
      expect(windows.tail.map((entry) => entry.index)).toEqual([2]);
      expect(windows.gap).toEqual({
        startIndex: 1,
        endIndex: 1,
        count: 1,
        bytes: Buffer.byteLength(JSON.stringify(values[1]) + "\n"),
      });
      const middle = await replay.readPage({
        cursor: 1,
        direction: "after",
        limit: { events: 1, bytes: 100 },
      });
      expect(middle.entries).toEqual([]);
      expect(middle.oversized).toEqual([{ index: 1, bytes: windows.gap!.bytes }]);
      expect(middle.nextCursor).toBe(2);
      expect(
        (await replay.readPage({ cursor: 2, direction: "after", limit: { events: 1, bytes: 100 } }))
          .entries[0].value,
      ).toEqual(values[2]);
      const full: typeof values = [];
      for await (const value of replay.streamAll()) full.push(value);
      expect(full).toEqual(values);
    } finally {
      await replay.close();
    }
  });

  it("pages the middle forwards and backwards without duplicates or overlaps", async () => {
    const values = Array.from({ length: 20 }, (_, index) => ({ index, text: "next" }));
    const replay = await AgentHistoryReplay.create(values);
    try {
      const forwards: typeof values = [],
        backwards: typeof values = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page = await replay.readPage({
          cursor,
          direction: "after",
          limit: { events: 3, bytes: 100 },
        });
        forwards.push(...page.entries.map((entry) => entry.value));
        cursor = page.nextCursor;
      }
      cursor = values.length;
      while (cursor !== null) {
        const page = await replay.readPage({
          cursor,
          direction: "before",
          limit: { events: 3, bytes: 100 },
        });
        backwards.unshift(...page.entries.map((entry) => entry.value));
        cursor = page.nextCursor;
      }
      expect(forwards).toEqual(values);
      expect(backwards).toEqual(values);
      expect(
        (
          await replay.readWindows({
            head: { events: 20, bytes: 10000 },
            tail: { events: 20, bytes: 10000 },
          })
        ).gap,
      ).toBeNull();
      await expect(
        replay.readPage({ cursor: 0, direction: "after", limit: { events: 0, bytes: 100 } }),
      ).rejects.toThrow("positive");
      await expect(
        replay.readPage({ cursor: 21, direction: "after", limit: { events: 1, bytes: 100 } }),
      ).rejects.toThrow("cursor");
    } finally {
      await replay.close();
    }
  });

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

  it("streams Unicode records without splitting characters across chunks", async () => {
    const events = [
      { text: "x".repeat(65520) + "🧠🌍", index: 1 },
      { text: "next", index: 2 },
    ];
    const replay = await AgentHistoryReplay.create(events);
    try {
      expect(await Array.fromAsync(replay.events())).toEqual(events);
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
