import { describe, expect, it } from "vitest";
import { summarizeWatchLoadEventLoop } from "./watch-load-metrics.js";

describe("watch load event-loop evidence", () => {
  it("normalizes the reported baseline without claiming a matched canary pass", () => {
    const result = summarizeWatchLoadEventLoop(58 * 60_000, [20_900], null);
    expect(result.stallCountOver10s).toBe(1);
    expect(result.stallsOver10sPerHour).toBeCloseTo(60 / 58);
    expect(result.maxStallOver10sMs).toBe(20_900);
    expect(result.p99Ms).toBeNull();
    expect(result.acceptance).toBe("pending-matched-baseline");
  });

  it("counts distinct stalls strictly over ten seconds and preserves the window histogram p99", () => {
    const result = summarizeWatchLoadEventLoop(3_600_000, [3_000, 10_000, 10_001, 25_200], 82);
    expect(result.stallCountOver10s).toBe(2);
    expect(result.stallsOver10sPerHour).toBe(2);
    expect(result.maxStallOver10sMs).toBe(25_200);
    expect(result.p99Ms).toBe(82);
  });

  it("does not treat a short run below two seconds as relative acceptance", () => {
    const result = summarizeWatchLoadEventLoop(90_000, [337], 18);
    expect(result.stallCountOver10s).toBe(0);
    expect(result.maxStallOver10sMs).toBe(0);
    expect(result.acceptance).toBe("pending-matched-baseline");
  });
});
