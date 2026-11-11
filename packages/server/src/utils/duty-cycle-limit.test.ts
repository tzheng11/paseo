import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDutyCycleLimit } from "./duty-cycle-limit.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createDutyCycleLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createLimit(overrides: { concurrency?: number; maxRestMs?: number } = {}) {
    return createDutyCycleLimit({
      concurrency: overrides.concurrency ?? 1,
      dutyCycle: 0.25,
      maxRestMs: overrides.maxRestMs ?? 60_000,
      now: () => Date.now(),
    });
  }

  it("keeps each slot busy for at most its duty cycle however many jobs are queued", async () => {
    const limit = createLimit({ concurrency: 2 });
    const starts: number[] = [];
    const job = async () => {
      starts.push(Date.now());
      await sleep(100);
    };
    const jobs = Array.from({ length: 8 }, () => limit(job));

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(jobs);

    // Two slots, 100 ms jobs, 300 ms rest: each slot starts a job every 400 ms.
    expect(starts).toEqual([0, 0, 400, 400, 800, 800, 1200, 1200]);
    const busyMs = 8 * 100;
    const wallMs = 1300;
    expect(busyMs / (2 * wallMs)).toBeLessThanOrEqual(0.33);
    expect(limit.takeStats()).toEqual({ busyMs: 800, restMs: 2400 });
    expect(limit.takeStats()).toEqual({ busyMs: 0, restMs: 0 });
  });

  it("settles a job when it finishes, while its slot rests", async () => {
    const limit = createLimit();
    let settledAt: number | null = null;
    const job = limit(async () => {
      await sleep(100);
      return "done";
    });
    void (async () => {
      await job;
      settledAt = Date.now();
    })();

    await vi.advanceTimersByTimeAsync(100);

    expect(settledAt).toBe(100);
    expect(limit.restingCount).toBe(1);
    expect(limit.activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(limit.restingCount).toBe(0);
    expect(limit.activeCount).toBe(0);
  });

  it("caps one rest at maxRestMs", async () => {
    const limit = createLimit({ maxRestMs: 500 });
    const starts: number[] = [];
    const job = async () => {
      starts.push(Date.now());
      await sleep(1_000);
    };
    const jobs = [limit(job), limit(job)];

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(jobs);

    expect(starts).toEqual([0, 1_500]);
  });

  it("rests after a failed job and rejects queued jobs when cleared", async () => {
    const limit = createLimit();
    const failed = limit(async () => {
      await sleep(100);
      throw new Error("git failed");
    });
    const queued = limit(async () => "never");
    const failedResult = expect(failed).rejects.toThrow("git failed");
    const queuedResult = expect(queued).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(100);
    await failedResult;
    expect(limit.restingCount).toBe(1);
    limit.clearQueue();
    await queuedResult;
  });

  it("rejects a duty cycle outside (0, 1]", () => {
    expect(() =>
      createDutyCycleLimit({ concurrency: 1, dutyCycle: 0, maxRestMs: 1, now: Date.now }),
    ).toThrow("Duty cycle");
  });
});
