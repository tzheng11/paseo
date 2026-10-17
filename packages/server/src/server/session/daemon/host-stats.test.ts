import { describe, expect, test } from "vitest";

import {
  CpuIdleSampler,
  countHostWork,
  darwinPressureName,
  darwinUsedBytes,
  parseMeminfo,
  parseSwapUsage,
  type CpuTimes,
} from "./host-stats.js";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12000.
Pages active:                            400000.
Pages inactive:                          380000.
Pages speculative:                         9000.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                          10000.
"Translation faults":                 912345678.
Pages copy-on-write:                   12345678.
Pages zero filled:                    123456789.
Pages reactivated:                      1234567.
Pages purged:                            123456.
File-backed pages:                       350000.
Anonymous pages:                         430000.
Pages stored in compressor:              300000.
Pages occupied by compressor:            100000.
Decompressions:                         1234567.
Compressions:                           2345678.
Pageins:                                3456789.
Pageouts:                                  4567.
Swapins:                                      0.
Swapouts:                                     0.
`;

function fakeSampler(times: CpuTimes[]) {
  let now = 0;
  let index = 0;
  const sleeps: number[] = [];
  const sampler = new CpuIdleSampler({
    readTimes: () => times[index++],
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return {
    sampler,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CpuIdleSampler", () => {
  test("takes a fresh 1 s sample on the first read", async () => {
    const { sampler, sleeps } = fakeSampler([
      { idle: 0, total: 0 },
      { idle: 750, total: 1000 },
    ]);

    await expect(sampler.read()).resolves.toEqual({ idlePercent: 75, sampleMs: 1000 });
    expect(sleeps).toEqual([1000]);
  });

  test("averages since the previous read when it is 2 s to 2 min old", async () => {
    const { sampler, sleeps, advance } = fakeSampler([
      { idle: 0, total: 0 },
      { idle: 900, total: 1000 },
      { idle: 1200, total: 16000 },
    ]);

    await sampler.read();
    advance(15_000);
    await expect(sampler.read()).resolves.toEqual({ idlePercent: 2, sampleMs: 15_000 });
    expect(sleeps).toEqual([1000]);
  });

  test.each([
    ["too recent", 500],
    ["stale", 300_000],
  ])("resamples when the previous read is %s", async (_label, gapMs) => {
    const { sampler, sleeps, advance } = fakeSampler([
      { idle: 0, total: 0 },
      { idle: 500, total: 1000 },
      { idle: 9000, total: 99000 },
      { idle: 9400, total: 100000 },
    ]);

    await sampler.read();
    advance(gapMs);
    await expect(sampler.read()).resolves.toEqual({ idlePercent: 40, sampleMs: 1000 });
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe("memory parsers", () => {
  test("macOS used memory is app + wired + compressed, as Activity Monitor shows", () => {
    expect(darwinUsedBytes(VM_STAT)).toBe((430000 - 10000 + 200000 + 100000) * 16384);
    expect(darwinUsedBytes("Mach Virtual Memory Statistics:")).toBeNull();
  });

  test("swap usage reads the used figure in any unit", () => {
    expect(
      parseSwapUsage("total = 30720.00M  used = 29481.06M  free = 1238.94M  (encrypted)"),
    ).toBe(Math.round(29481.06 * 1024 ** 2));
    expect(parseSwapUsage("total = 2.00G  used = 1.50G  free = 0.50G")).toBe(1.5 * 1024 ** 3);
    expect(parseSwapUsage("")).toBeNull();
  });

  test("macOS pressure levels map to names and unknown levels to null", () => {
    expect([1, 2, 4, 3, Number.NaN].map(darwinPressureName)).toEqual([
      "normal",
      "warn",
      "critical",
      null,
      null,
    ]);
  });

  test("Linux memory uses MemAvailable and swap total minus free", () => {
    expect(
      parseMeminfo(
        "MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n",
      ),
    ).toEqual({
      totalBytes: 16000000 * 1024,
      usedBytes: 10000000 * 1024,
      swapUsedBytes: 500000 * 1024,
      pressure: null,
    });
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });
});

test("work counts treat only running agents and workspaces as active", () => {
  expect(
    countHostWork({
      agents: [{ status: "running" }, { status: "idle" }, { status: "error" }],
      workspaces: [{ status: "running" }, { status: "needs_input" }, { status: "done" }],
    }),
  ).toEqual({ agents: { total: 3, running: 1 }, workspaces: { total: 3, running: 1 } });
});
