import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeSessionSchedulers, hasRuntimeShellChild } from "./idle-agent-unload.js";
import type { ToolCallTimelineItem } from "./agent-sdk-types.js";

function call(
  name: string,
  status: "running" | "completed" = "completed",
  callId = "create",
  input: unknown = null,
  output: unknown = null,
): ToolCallTimelineItem {
  return {
    type: "tool_call",
    name,
    status,
    callId,
    error: null,
    detail: { type: "unknown", input, output },
  };
}

test.each(["CronCreate", "ScheduleWakeup", "Monitor"])(
  "%s completion does not prove the scheduler ended",
  (name) => {
    const schedulers = new ClaudeSessionSchedulers();
    schedulers.observe(call(name, "running"));
    expect(schedulers.active).toBe(true);
    schedulers.observe(call(name));
    expect(schedulers.active).toBe(true);
    schedulers.observe({ ...call(name), status: "failed", error: "rejected" });
    expect(schedulers.active).toBe(false);
  },
);

test("only confirmed matching deletion retires a scheduler", () => {
  const schedulers = new ClaudeSessionSchedulers();
  schedulers.observe(call("CronCreate", "completed", "a", {}, JSON.stringify({ id: "job-a" })));
  schedulers.observe(
    call("CronDelete", "completed", "delete-b", { id: "job-b" }, { deleted: true }),
  );
  expect(schedulers.active).toBe(true);
  schedulers.observe(
    call("CronDelete", "completed", "delete-a", { id: "job-a" }, { deleted: true }),
  );
  expect(schedulers.active).toBe(false);
  schedulers.observe(call("CronCreate", "completed", "unknown", {}, "Unrecognized output"));
  schedulers.observe(
    call("CronDelete", "completed", "delete-a", { id: "job-a" }, { deleted: true }),
  );
  expect(schedulers.active).toBe(true);
});

test.skipIf(process.platform === "win32")("observes a real direct shell child", async () => {
  const child = spawn("/bin/sh", ["-c", "read value"], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    await once(child, "spawn");
    expect(await hasRuntimeShellChild(process.pid)).toBe(true);
  } finally {
    child.kill();
    await once(child, "exit");
  }
});

test("interrupted scheduler creation retains its runtime until confirmed deletion", () => {
  const schedulers = new ClaudeSessionSchedulers();
  schedulers.observe(call("CronCreate", "completed", "a", {}, { id: "job-a" }));
  schedulers.observe({ ...call("CronCreate", "running", "a"), status: "canceled" });
  expect(schedulers.active).toBe(true);
  schedulers.observe(
    call("CronDelete", "completed", "delete-a", { id: "job-a" }, { deleted: true }),
  );
  expect(schedulers.active).toBe(false);
});
