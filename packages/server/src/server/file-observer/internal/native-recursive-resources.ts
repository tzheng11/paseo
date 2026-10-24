import {
  FileObservationCapacityError,
  type FileObservationCapacityFailure,
  type FileObservationCapacityRetry,
} from "../capacity.js";
import {
  DEFAULT_NATIVE_MAX_TRACKED_ENTRIES,
  resolveNativeInventoryLimit,
} from "./native-recursive-limits.js";

// These limits apply across every native observer service in this process.
// Each of two admitted audits can additionally hold a candidate inventory and
// a shallow directory snapshot, each capped at the backend's 250,000-entry
// per-root limit. The configured retained limit plus one million transient
// entries bounds path counts independently of root count, not V8 heap bytes.
const MAX_CONCURRENT_AUDITS = 2;

export interface InventoryReservation {
  assertCanFit(entryCount: number): void;
  setEntryCount(entryCount: number): void;
  assertCanStart(): void;
  release(): void;
}

interface AuditJob {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

interface CapacityRetryJob {
  failure: FileObservationCapacityFailure;
  retry: FileObservationCapacityRetry;
  recheck: boolean;
  timer: NodeJS.Timeout;
  abort(): void;
  resolve(): void;
  reject(error: unknown): void;
}

export class NativeRecursiveResources {
  private retainedEntries = 0;
  private activeAudits = 0;
  private readonly queue: AuditJob[] = [];
  private readonly capacityRetries: CapacityRetryJob[] = [];
  private retryInFlight = false;

  constructor(
    private readonly limits = {
      maxTrackedEntries: DEFAULT_NATIVE_MAX_TRACKED_ENTRIES,
      maxConcurrentAudits: MAX_CONCURRENT_AUDITS,
    },
  ) {}

  createInventoryReservation(root: string): InventoryReservation {
    let retained = 0;
    const assertCanFit = (entryCount: number) => {
      if (this.retainedEntries - retained + entryCount > this.limits.maxTrackedEntries) {
        throw this.capacityError({
          root,
          scope: "shared",
          requiredEntries: entryCount,
          limit: this.limits.maxTrackedEntries,
        });
      }
    };
    const setEntryCount = (entryCount: number) => {
      assertCanFit(entryCount);
      this.retainedEntries += entryCount - retained;
      const released = entryCount < retained;
      retained = entryCount;
      if (released) this.pumpCapacityRetries();
    };
    return {
      assertCanFit,
      setEntryCount,
      // A healthy root must be able to replace its own inventory at capacity.
      // A retry without a retained inventory must fail before rescanning a root
      // while the shared budget remains exhausted.
      assertCanStart: () => assertCanFit(Math.max(1, retained)),
      release: () => setEntryCount(0),
    };
  }

  capacityError(failure: FileObservationCapacityFailure): FileObservationCapacityError {
    return new FileObservationCapacityError(failure, (retry) =>
      this.scheduleCapacityRetry(failure, retry),
    );
  }

  private scheduleCapacityRetry(
    failure: FileObservationCapacityFailure,
    retry: FileObservationCapacityRetry,
  ): Promise<void> {
    if (retry.signal.aborted) return Promise.reject(retry.signal.reason);
    return new Promise<void>((resolve, reject) => {
      const job: CapacityRetryJob = {
        failure,
        retry,
        recheck: false,
        timer: setTimeout(() => {
          job.recheck = true;
          this.pumpCapacityRetries();
        }, retry.recheckAfterMs),
        abort: () => {
          const index = this.capacityRetries.indexOf(job);
          if (index === -1) return;
          this.capacityRetries.splice(index, 1);
          clearTimeout(job.timer);
          reject(retry.signal.reason);
        },
        resolve,
        reject,
      };
      retry.signal.addEventListener("abort", job.abort, { once: true });
      this.capacityRetries.push(job);
      this.pumpCapacityRetries();
    });
  }

  private pumpCapacityRetries(): void {
    if (this.retryInFlight) return;
    const available = this.limits.maxTrackedEntries - this.retainedEntries;
    const index = this.capacityRetries.findIndex(
      (job) =>
        job.recheck || (job.failure.scope === "shared" && job.failure.requiredEntries <= available),
    );
    if (index === -1) return;
    const [job] = this.capacityRetries.splice(index, 1);
    clearTimeout(job!.timer);
    job!.retry.signal.removeEventListener("abort", job!.abort);
    this.retryInFlight = true;
    // Give the awakened root's subscription time to commit or release its
    // inventory before admitting another waiter against the same headroom.
    void Promise.resolve()
      .then(() => {
        job!.retry.signal.throwIfAborted();
        return job!.retry.run(job!.recheck ? "recheck" : "capacity-released");
      })
      .then(job!.resolve, job!.reject)
      .finally(() => {
        this.retryInFlight = false;
        this.pumpCapacityRetries();
      });
  }

  runAudit(run: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const job: AuditJob = {
        run,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pumpAudits();
    });
  }

  private pumpAudits(): void {
    while (this.activeAudits < this.limits.maxConcurrentAudits && this.queue.length) {
      const job = this.queue.shift()!;
      job.signal.removeEventListener("abort", job.abort);
      this.activeAudits += 1;
      void Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeAudits -= 1;
          this.pumpAudits();
        });
    }
  }
}

export const nativeRecursiveResources = new NativeRecursiveResources({
  maxTrackedEntries: resolveNativeInventoryLimit(process.env),
  maxConcurrentAudits: MAX_CONCURRENT_AUDITS,
});
