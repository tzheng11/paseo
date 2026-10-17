import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { ClaudeBackgroundTasks } from "./background-tasks.js";

const identity = { uuid: "66e4b0c4-8a9c-4c99-9c0f-f6d10e2efb9b", session_id: "claude-session" };
const started: SDKMessage = {
  ...identity,
  type: "system",
  subtype: "task_started",
  task_id: "shell-1",
  description: "background shell",
  task_type: "local_bash",
  is_backgrounded: true,
};
const completed: SDKMessage = {
  ...identity,
  type: "system",
  subtype: "task_notification",
  task_id: "shell-1",
  status: "completed",
  output_file: "",
  summary: "done",
};
const emptySnapshot: SDKMessage = {
  ...identity,
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [],
};

describe("Claude process-owned background work", () => {
  test("tracks a local_bash lifecycle even though it is absent from the subagent catalogue", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(started);
    expect(tasks.hasActive).toBe(true);
    tasks.observe(completed);
    expect(tasks.hasActive).toBe(false);
  });
  test("a full level snapshot replaces membership and includes unknown task kinds", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({
      ...identity,
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "future-1", task_type: "future_kind", description: "native work" }],
    });
    expect(tasks.hasActive).toBe(true);
    tasks.observe(emptySnapshot);
    expect(tasks.hasActive).toBe(false);
  });
  test("a stale start edge after an empty level snapshot cannot repopulate work", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(emptySnapshot);
    tasks.observe(started);
    tasks.observe({
      ...identity,
      type: "system",
      subtype: "task_updated",
      task_id: "shell-1",
      patch: { status: "running", is_backgrounded: true },
    });
    expect(tasks.hasActive).toBe(false);
  });
  test("a terminal edge cannot override a nonempty authoritative snapshot", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({
      ...identity,
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "shell-1", task_type: "local_bash", description: "shell" }],
    });
    tasks.observe(completed);
    expect(tasks.hasActive).toBe(true);
    tasks.observe(emptySnapshot);
    expect(tasks.hasActive).toBe(false);
  });
  test("unknown edge task kinds remain active until a terminal observation", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({ ...started, task_type: "future_kind", is_backgrounded: false });
    expect(tasks.hasActive).toBe(true);
    tasks.observe(completed);
    expect(tasks.hasActive).toBe(false);
  });
  test("moving a known foreground task into the background makes it active", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe({ ...started, task_type: "local_agent", is_backgrounded: false });
    expect(tasks.hasActive).toBe(false);
    tasks.observe({
      ...identity,
      type: "system",
      subtype: "task_updated",
      task_id: "shell-1",
      patch: { is_backgrounded: true },
    });
    expect(tasks.hasActive).toBe(true);
    tasks.observe(completed);
    expect(tasks.hasActive).toBe(false);
  });
  test("a replacement process starts with a fresh snapshot epoch", () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(emptySnapshot);
    tasks.reset();
    tasks.observe(started);
    expect(tasks.hasActive).toBe(true);
  });
});
