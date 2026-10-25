import { stat } from "node:fs/promises";
import type {
  FileChange,
  FileChangeType,
  FileObserverCallback,
  FileObserverOptions,
  FileObserverSubscription,
} from "../index.js";
import type {
  BackendDiagnostics,
  CreateObservationBackend,
  ObservationBackend,
  ObservationHost,
  ObserverMetrics,
} from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { toError } from "./paths.js";
import { observationWork } from "./work-slice.js";

const EVENT_BATCH_DELAY_MS = 10;
const MAX_DELIVERY_BATCH = 256;

export interface ManagedObservation {
  start(): Promise<void>;
  subscription(): FileObserverSubscription;
  close(): Promise<void>;
  getDiagnostics(): BackendDiagnostics & { pendingEventCount: number };
}

export function createManagedObservation(input: {
  root: string;
  callback: FileObserverCallback;
  options: FileObserverOptions;
  paths: ObserverPaths;
  metrics: ObserverMetrics;
  createBackend: CreateObservationBackend;
  onClosed: () => void;
}): ManagedObservation {
  return new Observation(input);
}

class Observation implements ManagedObservation, ObservationHost {
  readonly root: string;
  readonly metrics: ObserverMetrics;
  ignoredRoots: string[];
  private ignoredMatcher: (path: string) => boolean;
  private status: "open" | "failed" | "closed" = "open";
  private readonly backend: ObservationBackend;
  private readonly pendingEvents = new Map<string, FileChange>();
  private flushTimer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;
  private deliveryPromise: Promise<void> | null = null;

  constructor(
    private readonly input: {
      root: string;
      callback: FileObserverCallback;
      options: FileObserverOptions;
      paths: ObserverPaths;
      metrics: ObserverMetrics;
      createBackend: CreateObservationBackend;
      onClosed: () => void;
    },
  ) {
    this.root = input.root;
    this.metrics = input.metrics;
    this.ignoredRoots = input.paths.normalizeIgnoredRoots(input.root, input.options.ignore ?? []);
    this.ignoredMatcher = input.paths.ignoredMatcher(this.ignoredRoots);
    this.backend = input.createBackend(this);
  }

  async start(): Promise<void> {
    const rootStats = await stat(this.root);
    if (!rootStats.isDirectory()) {
      throw new Error(`File observation requires a directory: ${this.root}`);
    }
    try {
      await this.backend.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  subscription(): FileObserverSubscription {
    return {
      updateIgnore: (paths) => this.updateIgnore(paths),
      unsubscribe: () => this.close(),
    };
  }

  async updateIgnore(paths: string[]): Promise<void> {
    if (!this.isActive()) return;
    const next = this.input.paths.normalizeIgnoredRoots(this.root, paths);
    if (samePaths(this.ignoredRoots, next)) return;
    this.ignoredRoots = next;
    this.ignoredMatcher = this.input.paths.ignoredMatcher(next);
    try {
      // Cancel obsolete inventory work before pruning can yield. Attach both
      // rejection handlers immediately, including while pruning is suspended.
      await Promise.all([this.backend.updateIgnore(), this.pruneIgnoredEvents()]);
    } catch (error) {
      this.fail(toError(error));
      throw error;
    }
  }

  private async pruneIgnoredEvents(): Promise<void> {
    for (const path of this.pendingEvents.keys()) {
      const pause = observationWork.pause();
      if (pause) await pause;
      if (this.isIgnored(path)) this.pendingEvents.delete(path);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.status = "closed";
    this.cancelDelivery();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): BackendDiagnostics & { pendingEventCount: number } {
    return {
      ...this.backend.getDiagnostics(),
      pendingEventCount: this.pendingEvents.size,
    };
  }

  isActive(): boolean {
    return this.status === "open";
  }

  isIgnored(path: string): boolean {
    return this.ignoredMatcher(path);
  }

  isPathInside(root: string, path: string): boolean {
    return this.input.paths.isInside(root, path);
  }

  onInventoryAdmission(state: "queued" | "admitted"): void {
    if (this.isActive()) this.input.options.onInventoryAdmission?.(state);
  }

  onInventoryProgress(): void {
    if (this.isActive()) this.input.options.onInventoryProgress?.();
  }

  queueEvent(type: FileChangeType, path: string): void {
    if (!this.isActive() || this.isIgnored(path)) return;
    const previous = this.pendingEvents.get(path);
    this.pendingEvents.set(path, mergeChange(previous, { path, type }));
    this.scheduleDelivery();
  }

  private scheduleDelivery(): void {
    if (!this.isActive() || !this.pendingEvents.size) return;
    if (this.flushTimer || this.deliveryPromise) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.deliveryPromise = this.flushEvents().finally(() => {
        this.deliveryPromise = null;
        this.scheduleDelivery();
      });
      void this.deliveryPromise.catch((error: unknown) => this.fail(toError(error)));
    }, EVENT_BATCH_DELAY_MS);
  }

  private async flushEvents(): Promise<void> {
    while (this.isActive() && this.pendingEvents.size) {
      const events: FileChange[] = [];
      let visited = 0;
      for (const [path, event] of this.pendingEvents) {
        this.pendingEvents.delete(path);
        if (!this.isIgnored(path)) events.push(event);
        visited += 1;
        if (visited === MAX_DELIVERY_BATCH) break;
      }
      if (events.length) this.input.callback(null, events);
      // Subscriber work is synchronous. Even a cheap batch must give timers,
      // IPC and close/ignore cancellation a turn before the next callback.
      if (this.pendingEvents.size) await observationWork.pause(true);
    }
  }

  fail(error: Error): void {
    if (!this.isActive()) return;
    this.status = "failed";
    this.metrics.observerFailureCount += 1;
    this.cancelDelivery();
    this.beginFailureClose();
    this.input.callback(error, []);
  }

  private beginFailureClose(): void {
    this.closePromise = this.finishClose();
  }

  private finishClose(): Promise<void> {
    return Promise.all([this.backend.close(), this.deliveryPromise]).then(
      () => this.input.onClosed(),
      (error: unknown) => {
        this.input.onClosed();
        throw error;
      },
    );
  }

  private cancelDelivery(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingEvents.clear();
  }
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function mergeChange(previous: FileChange | undefined, next: FileChange): FileChange {
  if (!previous) return next;
  if (previous.type === "create" && next.type === "delete") return { ...next, type: "update" };
  if (previous.type === "delete" && next.type === "create") return { ...next, type: "update" };
  if (previous.type === "create") return previous;
  return next;
}
