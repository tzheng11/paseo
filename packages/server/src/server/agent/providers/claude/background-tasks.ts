import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const FOREGROUND_TASK_TYPES = new Set(["local_agent", "local_workflow", "local_bash"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);
const LIVE_TASK_STATUSES = new Set(["pending", "running", "paused"]);

/** Process-owned work is independent of the UI's filtered subagent catalogue. */
export class ClaudeBackgroundTasks {
  private readonly active = new Set<string>();
  private readonly foreground = new Set<string>();
  private hasSnapshot = false;

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  reset(): void {
    this.active.clear();
    this.foreground.clear();
    this.hasSnapshot = false;
  }

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    if (message.subtype === "background_tasks_changed") {
      this.hasSnapshot = true;
      this.active.clear();
      for (const task of message.tasks) this.active.add(task.task_id);
      return;
    }
    // Level snapshots and lifecycle edges have unspecified ordering. Once the
    // level signal exists, a stale start/finish edge cannot change that snapshot.
    if (this.hasSnapshot) return;
    if (message.subtype === "task_started") {
      const knownForeground =
        message.is_backgrounded === false && FOREGROUND_TASK_TYPES.has(message.task_type ?? "");
      if (knownForeground) this.foreground.add(message.task_id);
      else this.active.add(message.task_id);
    } else if (message.subtype === "task_updated") {
      const { status, is_backgrounded: backgrounded } = message.patch;
      if (TERMINAL_TASK_STATUSES.has(status ?? "")) {
        this.active.delete(message.task_id);
        this.foreground.delete(message.task_id);
      } else if (
        backgrounded === true ||
        !this.foreground.has(message.task_id) ||
        (status !== undefined && !LIVE_TASK_STATUSES.has(status))
      ) {
        this.active.add(message.task_id);
        this.foreground.delete(message.task_id);
      }
    } else if (message.subtype === "task_notification") {
      if (TERMINAL_TASK_STATUSES.has(message.status)) {
        this.active.delete(message.task_id);
        this.foreground.delete(message.task_id);
      } else this.active.add(message.task_id);
    }
  }
}
