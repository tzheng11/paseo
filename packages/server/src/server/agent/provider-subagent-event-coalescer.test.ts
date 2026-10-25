import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderSubagentEventCoalescer } from "./provider-subagent-event-coalescer.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentInputEvent,
  type ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";

function createHarness() {
  const events: ProviderSubagentStoreEvent[] = [];
  const store = new ProviderSubagentStore();
  const coalescer = new ProviderSubagentEventCoalescer({
    timers: { setTimeout, clearTimeout },
    onPublish: (event) => events.push(event),
  });
  const apply = (event: ProviderSubagentInputEvent, parentAgentId = "parent") => {
    const update = store.apply(parentAgentId, "codex", event);
    coalescer.publish(update);
    return update;
  };
  return { events, store, coalescer, apply };
}

describe("ProviderSubagentEventCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("publishes a running burst once per window while retaining its latest activity immediately", async () => {
    const { apply, events, store } = createHarness();
    apply({ type: "upsert", id: "child", status: "running", title: "Inspect" });
    for (let index = 1; index <= 1000; index++) {
      apply({
        type: "upsert",
        id: "child",
        subtitle: `step ${index}`,
        timestamp: new Date(index).toISOString(),
      });
    }
    expect(store.get("parent", "child")).toMatchObject({
      title: "Inspect",
      subtitle: "step 1000",
      status: "running",
      updatedAt: new Date(1000).toISOString(),
    });
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "upsert", subagent: store.get("parent", "child") });
  });

  test("flushes pending presentation before terminal changes and preserves sticky fields", async () => {
    const { apply, events, store } = createHarness();
    apply({ type: "upsert", id: "child", title: "Inspect", status: "running" });
    const pending = apply({ type: "upsert", id: "child", subtitle: "latest activity" });
    const terminal = apply({
      type: "upsert",
      id: "child",
      status: "completed",
      timestamp: "2026-10-24T20:00:01.000Z",
    });
    expect(events.slice(1)).toEqual([pending, terminal]);
    const presentation = apply({ type: "upsert", id: "child", subtitle: null });
    expect(events.at(-1)).toEqual(presentation);
    expect(store.get("parent", "child")).toMatchObject({
      title: "Inspect",
      status: "completed",
      subtitle: null,
    });
    const restarted = apply({ type: "upsert", id: "child", status: "running" });
    expect(events.at(-1)).toEqual(restarted);
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toHaveLength(5);
  });

  test("delivers every child timeline row immediately with its original sequence and bytes", async () => {
    const { apply, events, store } = createHarness();
    apply({ type: "upsert", id: "child", status: "running" });
    const pending = apply({ type: "upsert", id: "child", subtitle: "progress" });
    for (const text of ["first ", "🙂", " last"]) {
      apply({ type: "timeline", id: "child", item: { type: "assistant_message", text } });
    }
    expect(events.map((event) => event.type)).toEqual([
      "upsert",
      "timeline",
      "timeline",
      "timeline",
    ]);
    const rows = events.filter((event) => event.type === "timeline").map((event) => event.row);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "first " },
      { type: "assistant_message", text: "🙂" },
      { type: "assistant_message", text: " last" },
    ]);
    expect(store.fetchTimeline("parent", "child").rows).toMatchObject([
      { seq: 3, item: { text: "first 🙂 last" } },
    ]);
    await vi.advanceTimersByTimeAsync(60);
    expect(events.at(-1)).toEqual(pending);
  });

  test("orders removal after the last descriptor and does not publish an obsolete timer", async () => {
    const { apply, events } = createHarness();
    apply({ type: "upsert", id: "child", status: "running" });
    const pending = apply({ type: "upsert", id: "child", title: "last old title" });
    const removed = apply({ type: "remove", id: "child" });
    const replacement = apply({
      type: "upsert",
      id: "child",
      title: "new child",
      status: "running",
    });
    expect(events.slice(1)).toEqual([pending, removed, replacement]);
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toHaveLength(4);
  });

  test("flushes and forgets one parent without canceling another parent's same child ID", async () => {
    const { apply, coalescer, events } = createHarness();
    apply({ type: "upsert", id: "child", status: "running" });
    apply({ type: "upsert", id: "child", status: "running" }, "other-parent");
    const pending = apply({ type: "upsert", id: "child", subtitle: "before close" });
    const otherPending = apply(
      { type: "upsert", id: "child", subtitle: "other activity" },
      "other-parent",
    );
    coalescer.flushAndDiscardParent("parent");
    expect(events.at(-1)).toEqual(pending);
    const replacement = apply({ type: "upsert", id: "child", title: "reopened" });
    expect(events.at(-1)).toEqual(replacement);
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toEqual(otherPending);
  });

  test("keeps history publication immediate and drains pending descriptors on explicit flush", async () => {
    const { apply, coalescer, events, store } = createHarness();
    apply({ type: "upsert", id: "child", status: "running" });
    const pending = apply({ type: "upsert", id: "child", subtitle: "live activity" });
    const history = store.apply("parent", "codex", {
      type: "upsert",
      id: "child",
      title: "history title",
    });
    coalescer.publish(history, { coalesce: false });
    expect(events.slice(1)).toEqual([pending, history]);
    const latest = apply({ type: "upsert", id: "child", title: "last live title" });
    coalescer.flushAll();
    expect(events.at(-1)).toEqual(latest);
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toHaveLength(4);
  });

  test.each(["history", "terminal"] as const)(
    "publishes the first live descriptor after %s immediately and forgets its previous timer",
    async (boundary) => {
      const { apply, coalescer, events, store } = createHarness();
      apply({ type: "upsert", id: "child", status: "running" });
      const pending = apply({ type: "upsert", id: "child", title: "before boundary" });
      const update = store.apply("parent", "codex", {
        type: "upsert",
        id: "child",
        status: boundary === "terminal" ? "completed" : "running",
        title: "boundary",
      });
      coalescer.publish(update, { coalesce: boundary !== "history" });
      expect(events.slice(1)).toEqual([pending, update]);

      const firstLive = apply({
        type: "upsert",
        id: "child",
        status: "running",
        title: "first live",
      });
      expect(events.at(-1)).toEqual(firstLive);
      const nextLive = apply({ type: "upsert", id: "child", title: "next live" });
      expect(events).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(59);
      expect(events).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toHaveLength(5);
      expect(events.at(-1)).toEqual(nextLive);
      await vi.advanceTimersByTimeAsync(60);
      expect(events).toHaveLength(5);
    },
  );
});
