export function summarizeWatchLoadEventLoop(
  durationMs: number,
  stallDurationsMs: number[],
  p99Ms: number | null,
) {
  const longStalls = stallDurationsMs.filter((duration) => duration > 10_000);
  return {
    durationMs,
    stallCountOver10s: longStalls.length,
    stallsOver10sPerHour: (longStalls.length * 3_600_000) / durationMs,
    maxStallOver10sMs: longStalls.length ? Math.max(...longStalls) : 0,
    p99Ms,
    histogramResolutionMs: 10,
    acceptance: "pending-matched-baseline" as const,
  };
}
