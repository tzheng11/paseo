import pLimit from "p-limit";

export interface DutyCycleLimitOptions {
  concurrency: number;
  /** Share of wall time each slot may spend running jobs, in (0, 1]. */
  dutyCycle: number;
  /** Longest rest after one job, so a single pathological job cannot park a slot. */
  maxRestMs: number;
  now: () => number;
}

export interface DutyCycleLimitStats {
  busyMs: number;
  restMs: number;
}

export interface DutyCycleLimit {
  <T>(job: () => Promise<T> | T): Promise<T>;
  /** Slots running a job or resting after one. */
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly restingCount: number;
  clearQueue(): void;
  /** Run and rest time accumulated since the previous call. */
  takeStats(): DutyCycleLimitStats;
}

/**
 * A concurrency limit whose slots rest after every job for `runTime * (1 / dutyCycle - 1)`.
 * However many jobs a fan-out queues, each slot then stays busy for at most `dutyCycle` of
 * wall time, so queued background Git work leaves the disk to foreground commands. The job's
 * own promise settles as soon as it finishes; only the slot waits.
 */
export function createDutyCycleLimit(options: DutyCycleLimitOptions): DutyCycleLimit {
  if (!(options.dutyCycle > 0 && options.dutyCycle <= 1)) {
    throw new Error(`Duty cycle must be in (0, 1], got ${options.dutyCycle}`);
  }
  const limit = pLimit({ concurrency: options.concurrency, rejectOnClear: true });
  const restRatio = 1 / options.dutyCycle - 1;
  let restingCount = 0;
  let busyMs = 0;
  let restMs = 0;

  const run = <T>(job: () => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolveJob, rejectJob) => {
      limit(async () => {
        const startedAtMs = options.now();
        try {
          resolveJob(await job());
        } catch (error) {
          rejectJob(error);
        }
        const ranMs = Math.max(0, options.now() - startedAtMs);
        busyMs += ranMs;
        const restForMs = Math.min(options.maxRestMs, ranMs * restRatio);
        if (restForMs <= 0) {
          return;
        }
        restingCount += 1;
        try {
          await new Promise<void>((resolveRest) => {
            setTimeout(resolveRest, restForMs).unref?.();
          });
        } finally {
          restingCount -= 1;
          restMs += restForMs;
        }
      }).catch(rejectJob);
    });

  return Object.defineProperties(run, {
    activeCount: { get: () => limit.activeCount },
    pendingCount: { get: () => limit.pendingCount },
    restingCount: { get: () => restingCount },
    clearQueue: { value: () => limit.clearQueue() },
    takeStats: {
      value: (): DutyCycleLimitStats => {
        const stats = { busyMs, restMs };
        busyMs = 0;
        restMs = 0;
        return stats;
      },
    },
  }) as DutyCycleLimit;
}
