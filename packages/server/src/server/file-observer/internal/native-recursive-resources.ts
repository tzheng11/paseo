// These limits apply across every native observer service in this process.
// Each of two admitted audits can additionally hold a candidate inventory and
// a shallow directory snapshot, each capped at the backend's 250,000-entry
// per-root limit. This bounds indexed and transient path entries to two million
// across arbitrarily many roots; it does not bound bytes retained by the GC.
const MAX_RETAINED_ENTRIES = 1_000_000;
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

export class NativeRecursiveResources {
  private retainedEntries = 0;
  private activeAudits = 0;
  private readonly queue: AuditJob[] = [];

  constructor(
    private readonly limits = {
      maxTrackedEntries: MAX_RETAINED_ENTRIES,
      maxConcurrentAudits: MAX_CONCURRENT_AUDITS,
    },
  ) {}

  createInventoryReservation(root: string): InventoryReservation {
    let retained = 0;
    const assertCanFit = (entryCount: number) => {
      if (this.retainedEntries - retained + entryCount > this.limits.maxTrackedEntries) {
        throw new Error(
          `Recursive file observation exceeded shared inventory limit of ${this.limits.maxTrackedEntries} entries under ${root}`,
        );
      }
    };
    const setEntryCount = (entryCount: number) => {
      assertCanFit(entryCount);
      this.retainedEntries += entryCount - retained;
      retained = entryCount;
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

export const nativeRecursiveResources = new NativeRecursiveResources();
