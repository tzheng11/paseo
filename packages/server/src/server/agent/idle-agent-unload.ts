import path from "node:path";
import { execCommand } from "../../utils/spawn.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

/** A failed or incomplete census must never authorize terminating a runtime. */
export async function hasRuntimeShellChild(pid: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  const { stdout } = await execCommand("ps", ["-axo", "pid=,ppid=,comm="], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error("Incomplete process census");
      return { pid: Number(match[1]), parent: Number(match[2]), command: path.basename(match[3]!) };
    });
  if (!rows.some((row) => row.pid === pid)) return true;
  const shells = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "nu", "pwsh"]);
  return rows.some((row) => row.parent === pid && shells.has(row.command.replace(/^-/, "")));
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function schedulerId(value: unknown): string | null {
  const entry = object(value);
  const id = entry?.id ?? entry?.jobId ?? entry?.job_id;
  return typeof id === "string" ? id : null;
}

/** A completed scheduler-creation call can leave its timer live inside the process. */
export class ClaudeSessionSchedulers {
  private readonly calls = new Map<string, string | null>();

  get active(): boolean {
    return this.calls.size > 0;
  }

  observe(item: AgentTimelineItem): void {
    if (item.type !== "tool_call") return;
    if (["CronCreate", "ScheduleWakeup", "Monitor"].includes(item.name)) {
      if (item.status === "failed") {
        this.calls.delete(item.callId);
      } else {
        const id = item.detail.type === "unknown" ? schedulerId(item.detail.output) : null;
        // Interrupted creation leaves timer ownership uncertain.
        this.calls.set(item.callId, id ?? this.calls.get(item.callId) ?? null);
      }
    } else if (item.name === "CronDelete" && item.status === "completed") {
      if (item.detail.type !== "unknown") return;
      const id = schedulerId(item.detail.input);
      const output = object(item.detail.output);
      if (id === null || output?.deleted !== true) return;
      for (const [callId, jobId] of this.calls) {
        if (jobId === id) this.calls.delete(callId);
      }
    }
  }
}
