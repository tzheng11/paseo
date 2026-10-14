import { describe, expect, it, vi } from "vitest";
import { publishAgentStream, type PluginLifecycle } from "./index.js";
import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";

const agent = {
  id: "a",
  workspaceId: null,
  parentAgentId: null,
  provider: "codex",
  cwd: "/fixture",
  title: null,
};

describe("plugin stream timeline loading", () => {
  it("does not load full history for metadata events or a turn start", () => {
    const emit = vi.fn();
    const lifecycle = { emit } as unknown as PluginLifecycle;
    const getTimeline = vi.fn(() => {
      throw new Error("must not load history");
    });
    const events: AgentStreamEvent[] = [
      { type: "thread_started", provider: "codex", sessionId: "s" },
      { type: "turn_started", provider: "codex", turnId: "t" },
      { type: "thinking_option_changed", provider: "codex", thinkingOptionId: null },
    ];
    for (const event of events) publishAgentStream(lifecycle, agent, event, getTimeline);
    expect(getTimeline).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledExactlyOnceWith("agent.turn_started", { agent, turnId: "t" });
  });

  it.each(["turn_completed", "turn_failed", "turn_canceled"] as const)(
    "preserves complete history for %s hooks",
    (type) => {
      const emit = vi.fn();
      const lifecycle = { emit } as unknown as PluginLifecycle;
      const timeline = [
        { type: "user_message" as const, text: "oldest message" },
        { type: "assistant_message" as const, text: "latest message" },
      ];
      const getTimeline = vi.fn(() => timeline);
      let event: AgentStreamEvent;
      if (type === "turn_completed") event = { type, provider: "codex" };
      else if (type === "turn_failed") event = { type, provider: "codex", error: "failed" };
      else event = { type, provider: "codex", reason: "canceled" };
      publishAgentStream(lifecycle, agent, event, getTimeline);
      expect(getTimeline).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith(
        "agent.turn_ended",
        expect.objectContaining({ agent, timeline }),
      );
    },
  );
});

it("marks the bounded hook timeline and provider middle explicitly", () => {
  const emit = vi.fn();
  const timelineGap = { startIndex: 64, endIndex: 700, count: 637, bytes: 1000000 };
  const providerHistoryGap = { startIndex: 32, endIndex: 10000, count: 9969, bytes: 100000000 };
  publishAgentStream(
    { emit } as unknown as PluginLifecycle,
    agent,
    { type: "turn_completed", provider: "codex" },
    () => [{ type: "assistant_message", text: "recent" }],
    () => ({ timelineGap, providerHistoryGap }),
  );
  expect(emit).toHaveBeenCalledWith(
    "agent.turn_ended",
    expect.objectContaining({ timelineGap, providerHistoryGap }),
  );
});
