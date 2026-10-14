const MAX_SLICE_MS = 4;
const MAX_SLICE_ENTRIES = 256;

// Shared across observations and delivery. Independent budgets let concurrent
// scans renew one another's time allowance without returning to the event loop.
class WorkSlice {
  private deadline = performance.now() + MAX_SLICE_MS;
  private entries = 0;
  private pending: Promise<void> | null = null;

  pause(force = false): Promise<void> | undefined {
    if (this.pending) return this.pending;
    this.entries += 1;
    if (!force && this.entries < MAX_SLICE_ENTRIES && performance.now() < this.deadline) return;
    this.pending = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.entries = 0;
        this.deadline = performance.now() + MAX_SLICE_MS;
        this.pending = null;
        resolve();
      });
    });
    return this.pending;
  }
}

export const observationWork = new WorkSlice();
