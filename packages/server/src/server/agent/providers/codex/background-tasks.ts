import { extractCodexTerminalSessionId } from "../tool-call-mapper-utils.js";

/** Live process-owned commands only. Tool completion can leave a native PTY running. */
export class CodexBackgroundTasks {
  private readonly jobs = new Map<string, string | null>();
  private readonly outputTails = new Map<string, string>();
  private readonly completed = new Map<string, Set<string | null>>();
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
    // Chunks can split the digits in a session ID. Keep the command active,
    // then associate the complete ID when the tool result arrives.
    this.started(key);
  }

  interaction(key: string | null, processId: string | null): void {
    if (!processId) {
      this.started(key);
      return;
    }
    const alias = key ?? `process:${processId}`;
    if (this.completed.get(alias)?.has(processId)) return;
    const previous = this.jobs.get(alias);
    if (previous && previous !== processId) this.jobs.set(`process:${previous}`, previous);
    this.jobs.set(alias, processId);
  }

  legacyFinished(key: string | null, output: string | null, exitCode: number | null): void {
    this.finish(key, output, exitCode);
  }

  private finish(
    key: string | null,
    output: string | null,
    exitCode: number | null,
    processId?: string,
  ): void {
    if (processId && exitCode !== null) {
      this.confirmExit(key, processId);
      return;
    }
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
    // A markerless mirrored tool envelope is not proof that a yielded PTY exited.
    // Only the typed command item with native process identity can release it.
    if (exited && !processId) return;
    this.confirmExit(key, exited ?? null);
  }

  private confirmExit(key: string | null, exited: string | null): void {
    if (exited) {
      for (const [alias, id] of this.jobs)
        if (id === exited) {
          this.jobs.delete(alias);
          this.markCompleted(alias, exited);
        }
    }
    if (key) {
      if (!exited || !this.jobs.get(key) || this.jobs.get(key) === exited) {
        this.jobs.delete(key);
        this.outputTails.delete(key);
      }
      this.markCompleted(key, exited);
    }
  }

  private markCompleted(key: string, processId: string | null): void {
    const processes = this.completed.get(key) ?? new Set<string | null>();
    processes.add(processId);
    if (processes.size > 16) processes.delete(processes.values().next().value!);
    this.completed.set(key, processes);
    if (this.completed.size > 1024) this.completed.delete(this.completed.keys().next().value!);
  }

  item(key: string | null, item: Record<string, unknown>, finished: boolean): void {
    const processId = typeof item.processId === "number" ? String(item.processId) : item.processId;
    const id = typeof processId === "string" && processId ? processId : undefined;
    if (key && this.completed.get(key)?.has(id ?? null)) return;
    if (id) this.interaction(key, id);
    else this.started(key);
    if (!finished) return;
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    if (item.status === "declined" && !id && key && this.jobs.get(key) === null) {
      this.finish(key, null, 0);
      return;
    }
    this.finish(
      key,
      typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
      exitCode,
      id,
    );
  }
}
