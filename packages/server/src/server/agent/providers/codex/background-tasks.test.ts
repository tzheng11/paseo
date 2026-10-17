import { expect, test } from "vitest";
import { CodexBackgroundTasks } from "./background-tasks.js";

test("a legacy tool yield remains active even when its tool envelope reports success", () => {
  const work = new CodexBackgroundTasks();
  work.started("thread:exec");
  work.output("thread:exec", "Process running with session id 42");
  work.output("thread:exec", "42");
  work.finished("thread:exec", null, 0);
  expect(work.active).toBe(true);
  work.interaction("thread:poll", "4242");
  work.finished("thread:poll", null, 0);
  expect(work.active).toBe(false);
});

test("modern command completion requires actual exit status and clears matching process aliases", () => {
  const work = new CodexBackgroundTasks();
  work.item("thread:exec", { processId: "73", status: "inProgress" }, false);
  work.item("thread:exec", { processId: "73", status: "completed", exitCode: null }, true);
  expect(work.active).toBe(true);
  work.interaction("thread:poll", "73");
  work.item("thread:exec", { processId: "73", status: "completed", exitCode: 0 }, true);
  expect(work.active).toBe(false);
  work.started("thread:exec"); // Late mirrored begin must not resurrect the completed call.
  expect(work.active).toBe(false);
});

test("missing lifecycle information holds work rather than guessing the process exited", () => {
  const work = new CodexBackgroundTasks();
  work.started("thread:unknown");
  work.finished("thread:unknown", null, null);
  work.finished("thread:unrelated", null, 0);
  expect(work.active).toBe(true);
  work.started(null);
  work.finished("thread:unknown", null, 0);
  expect(work.active).toBe(true);
});

test("ordinary commands with confirmed exit and commands refused before launch do not hold idle admission", () => {
  const work = new CodexBackgroundTasks();
  work.started("thread:ordinary");
  work.finished("thread:ordinary", "done", 0);
  expect(work.active).toBe(false);
  work.item("thread:declined", { status: "declined" }, true);
  expect(work.active).toBe(false);
});
