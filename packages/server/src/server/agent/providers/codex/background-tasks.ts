import { extractCodexTerminalSessionId } from "../tool-call-mapper-utils.js";

/** Live process-owned commands only. Tool completion can leave a native PTY running. */
export class CodexBackgroundTasks {
  private readonly jobs = new Map<string, string | null>();
  private readonly outputTails = new Map<string, string>();
  private readonly completed = new Set<string>();
  private unidentified = false;

  get active(): boolean {
    return this.unidentified || this.jobs.size > 0;
  }

  started(key: string | null): void {
    if (key === null) {
      this.unidentified = true;
      return;
    }
    if (!this.completed.has(key) && !this.jobs.has(key)) this.jobs.set(key, null);
  }

  output(key: string | null, chunk: string): void {
    if (!key) return;
    const tail = `${this.outputTails.get(key) ?? ""}${chunk}`.slice(-512);
    this.outputTails.set(key, tail);
    const processId = extractCodexTerminalSessionId(tail);
    if (processId) this.jobs.set(key, processId);
  }

  interaction(key: string | null, processId: string | null): void {
    if (processId) this.jobs.set(key ?? `process:${processId}`, processId);
    else this.started(key);
  }

  finished(
    key: string | null,
    output: string | null,
    exitCode: number | null,
    processId?: string,
  ): void {
    const running =
      extractCodexTerminalSessionId(output ?? undefined) ??
      (key ? extractCodexTerminalSessionId(this.outputTails.get(key)) : undefined);
    if (running) {
      this.interaction(key, running);
      if (key) this.outputTails.delete(key);
      return;
    }
    if (exitCode === null) {
      if (processId) this.interaction(key, processId);
      else this.started(key);
      return;
    }
    const exited = processId ?? (key ? this.jobs.get(key) : null);
    if (exited) {
      for (const [alias, id] of this.jobs) if (id === exited) this.jobs.delete(alias);
    }
    if (key) {
      this.jobs.delete(key);
      this.outputTails.delete(key);
      this.completed.add(key);
      if (this.completed.size > 1024) this.completed.delete(this.completed.values().next().value!);
    }
  }

  item(key: string | null, item: Record<string, unknown>, finished: boolean): void {
    const processId = typeof item.processId === "number" ? String(item.processId) : item.processId;
    const id = typeof processId === "string" && processId ? processId : undefined;
    if (id) this.interaction(key, id);
    else this.started(key);
    if (!finished) return;
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    if (item.status === "declined" && !id && key && this.jobs.get(key) === null) {
      this.finished(key, null, 0);
      return;
    }
    this.finished(
      key,
      typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
      exitCode,
      id,
    );
  }
}
