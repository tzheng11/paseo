import { afterEach, expect, test, vi } from "vitest";
import { resolve } from "node:path";
import type { AgentManagerEvent, AgentSubscriber, ManagedAgent } from "./agent/agent-manager.js";
import { observeActiveWorkspaceGit } from "./active-workspace-git-observer.js";

afterEach(() => vi.useRealTimers());

test("running agents retain shared coverage without clients and release it after the final turn", async () => {
  vi.useFakeTimers();
  const cwd = resolve("/tmp/repo");
  let emit: AgentSubscriber = () => {};
  const registered: string[] = [];
  const released: string[] = [];
  const stop = observeActiveWorkspaceGit({
    agentManager: {
      subscribe(callback, options) {
        expect(options).toEqual({ replayState: true, includeInternal: true });
        emit = callback;
        return () => {};
      },
    },
    workspaceGitService: {
      registerWorkspace({ cwd: targetCwd }) {
        registered.push(targetCwd);
        return { unsubscribe: () => released.push(targetCwd) };
      },
    },
  });
  function state(id: string, lifecycle: ManagedAgent["lifecycle"]): AgentManagerEvent {
    return { type: "agent_state", agent: { id, cwd, lifecycle } as ManagedAgent };
  }
  emit(state("first", "running"));
  emit(state("second", "running"));
  expect(registered).toEqual([cwd]);
  emit(state("first", "idle"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(released).toEqual([]);
  emit(state("second", "closed"));
  await vi.advanceTimersByTimeAsync(59_999);
  expect(released).toEqual([]);
  emit(state("second", "running"));
  await vi.advanceTimersByTimeAsync(1);
  expect(released).toEqual([]);
  emit(state("second", "idle"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(released).toEqual([cwd]);
  emit(state("second", "running"));
  expect(registered).toEqual([cwd, cwd]);
  stop();
  expect(released).toEqual([cwd, cwd]);
});
