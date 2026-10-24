import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  type AgentStreamCoalescerTimers,
} from "./agent-stream-coalescer.js";
import type { ProviderSubagentStoreEvent } from "./provider-subagents/store.js";

type DescriptorUpdate = Extract<ProviderSubagentStoreEvent, { type: "upsert" }>;

interface DescriptorPublication {
  parentAgentId: string;
  pending: DescriptorUpdate | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ProviderSubagentEventCoalescerOptions {
  windowMs?: number;
  timers: AgentStreamCoalescerTimers;
  onPublish(event: ProviderSubagentStoreEvent): void;
}

/** Store mutations happen before publication; only running descriptor snapshots may wait. */
export class ProviderSubagentEventCoalescer {
  private readonly descriptors = new Map<string, DescriptorPublication>();
  private readonly windowMs: number;

  constructor(private readonly options: ProviderSubagentEventCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
  }

  publish(event: ProviderSubagentStoreEvent, options?: { coalesce: boolean }): void {
    if (event.type === "timeline") {
      this.options.onPublish(event);
      return;
    }
    const parentAgentId =
      event.type === "upsert" ? event.subagent.parentAgentId : event.parentAgentId;
    const subagentId = event.type === "upsert" ? event.subagent.id : event.subagentId;
    const key = `${parentAgentId}\0${subagentId}`;
    const previous = this.descriptors.get(key);
    if (
      event.type === "remove" ||
      options?.coalesce === false ||
      event.subagent.status !== "running"
    ) {
      this.flush(key, previous);
      this.descriptors.delete(key);
      this.options.onPublish(event);
      return;
    }
    if (!previous) {
      this.descriptors.set(key, {
        parentAgentId,
        pending: null,
        timer: null,
      });
      this.options.onPublish(event);
      return;
    }
    previous.pending = event;
    if (previous.timer === null) {
      previous.timer = this.options.timers.setTimeout(
        () => this.flush(key, previous),
        this.windowMs,
      );
      previous.timer.unref?.();
    }
  }

  flushAll(): void {
    for (const [key, publication] of this.descriptors) this.flush(key, publication);
  }

  flushAndDiscardParent(parentAgentId: string): void {
    for (const [key, publication] of this.descriptors) {
      if (publication.parentAgentId !== parentAgentId) continue;
      this.flush(key, publication);
      this.descriptors.delete(key);
    }
  }

  private flush(key: string, expected?: DescriptorPublication): void {
    const publication = this.descriptors.get(key);
    if (!publication || (expected && publication !== expected)) return;
    if (publication.timer !== null) this.options.timers.clearTimeout(publication.timer);
    publication.timer = null;
    const pending = publication.pending;
    publication.pending = null;
    if (pending) this.options.onPublish(pending);
  }
}
