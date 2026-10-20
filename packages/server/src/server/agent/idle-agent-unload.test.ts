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
  schedulers.observe(
    call(
      "CronCreate",
      "completed",
      "a",
      {},
      { output: { id: "job-a", humanSchedule: "every 5 minutes", recurring: true } },
    ),
  );
  schedulers.observe(call("CronDelete", "completed", "delete-b", { id: "job-b" }, { id: "job-b" }));
  expect(schedulers.active).toBe(true);
  schedulers.observe(call("CronDelete", "completed", "delete-a", { id: "job-a" }, { id: "job-a" }));
  expect(schedulers.active).toBe(false);
  schedulers.observe(call("CronCreate", "completed", "unknown", {}, "Unrecognized output"));
  schedulers.observe(call("CronDelete", "completed", "delete-a", { id: "job-a" }, { id: "job-a" }));
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
  schedulers.observe(
    call(
      "CronCreate",
      "completed",
      "a",
      {},
      { output: { id: "job-a", humanSchedule: "every 5 minutes", recurring: true } },
    ),
  );
  schedulers.observe({ ...call("CronCreate", "running", "a"), status: "canceled" });
  expect(schedulers.active).toBe(true);
  schedulers.observe(call("CronDelete", "completed", "delete-a", { id: "job-a" }, { id: "job-a" }));
  expect(schedulers.active).toBe(false);
});

test.each(["text", "sdk"])(
  "ISS-4420 review 4: wrapped Claude CronCreate/CronDelete %s results retire the matching scheduler",
  (shape) => {
    const schedulers = new ClaudeSessionSchedulers();
    // Claude's mapToolResultToToolResultBlockParam renders these messages; the
    // provider's generic result projection wraps them in { output: content }.
    const creation =
      "Scheduled recurring job a1b2c3d4 (every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 3 days. Use CronDelete to cancel sooner.";
    schedulers.observe(call("CronCreate", "completed", "a", {}, { output: creation }));
    schedulers.observe(
      call("CronDelete", "completed", "wrong", { id: "other" }, { output: "Cancelled job other." }),
    );
    expect(schedulers.active).toBe(true);
    schedulers.observe(
      call(
        "CronDelete",
        "completed",
        "delete-a",
        { id: "a1b2c3d4" },
        {
          output: shape === "text" ? "Cancelled job a1b2c3d4." : { id: "a1b2c3d4" },
        },
      ),
    );
    expect(schedulers.active).toBe(false);
  },
);
