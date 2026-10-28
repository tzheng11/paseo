import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("bounds nested unknown tool inputs and results without losing their structure", () => {
    const large = "x".repeat(1024 * 1024);
    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "structured-result",
      name: "mcp",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { command: large, enabled: true },
        output: { content: [{ type: "text", text: large }], total: 5, more: null },
      },
    });
    const clipped =
      "x".repeat(64 * 1024 - "\n\n[Content truncated]".length) + "\n\n[Content truncated]";
    expect(item).toMatchObject({
      detail: {
        input: { command: clipped, enabled: true },
        output: { content: [{ type: "text", text: clipped }], total: 5, more: null },
      },
    });
    expect(limitAgentTimelineItemContent(item)).toEqual(item);
    expect(large).toHaveLength(1024 * 1024);
  });
  test.each([false, true])(
    "preserves the exact UTF-16 prefix for oversized shell output (failed=%s)",
    (failed) => {
      const text = "x".repeat(64 * 1024 - 1) + "🙂";
      const item = limitAgentTimelineItemContent({
        type: "tool_call",
        callId: "large-shell",
        name: "Bash",
        status: failed ? "failed" : "completed",
        detail: { type: "shell", command: "echo large", output: text },
        error: failed ? { content: text } : null,
      });
      expect(item).toEqual({
        type: "tool_call",
        callId: "large-shell",
        name: "Bash",
        status: failed ? "failed" : "completed",
        detail: { type: "shell", command: "echo large", output: text.slice(0, 64 * 1024) },
        error: failed ? { content: text.slice(0, 64 * 1024) } : null,
      });
    },
  );

  test("marks truncated plain-text tool content within the content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(limitAgentTimelineItemContent(item)).toEqual(item);
    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024 - "\n\n[Content truncated]".length) + "\n\n[Content truncated]",
        icon: "square_terminal",
      },
    });
  });
});
