import { describe, expect, test } from "vitest";
import type { HostStats } from "@getpaseo/protocol/messages";
import {
  buildHostOverviewRows,
  formatGigabytes,
  hostLoadWarnings,
  resolveHostOverviewState,
  supportsHostStats,
  type HostOverviewState,
} from "./model";

const GB = 1024 ** 3;

function stats(input: {
  idlePercent?: number;
  cores?: number;
  swapUsedBytes?: number | null;
  gitPending?: number;
}): HostStats {
  return {
    collectedAt: "2026-10-17T06:00:00.000Z",
    agents: { total: 10, running: 2 },
    workspaces: { total: 6, running: 1 },
    cpu: {
      cores: input.cores ?? 10,
      idlePercent: input.idlePercent ?? 50,
      sampleMs: 15_000,
      loadAverage: [1, 1, 1],
    },
    memory: {
      totalBytes: 64 * GB,
      usedBytes: 40 * GB,
      swapUsedBytes: input.swapUsedBytes === undefined ? 0 : input.swapUsedBytes,
      pressure: "normal",
    },
    git: { active: 0, pending: input.gitPending ?? 0 },
  };
}

function ready(value: HostStats): HostOverviewState {
  return { kind: "ready", stats: value, warnings: hostLoadWarnings(value) };
}

describe("hostLoadWarnings", () => {
  test("uses the /spawn thresholds: swap over 4 GB, under 15% idle, Git queue of 20", () => {
    expect(hostLoadWarnings(stats({}))).toEqual([]);
    expect(
      hostLoadWarnings(stats({ swapUsedBytes: 4 * GB, idlePercent: 15, gitPending: 19 })),
    ).toEqual([]);
    expect(
      hostLoadWarnings(stats({ swapUsedBytes: 5 * GB, idlePercent: 14.9, gitPending: 20 })),
    ).toEqual([
      { kind: "swap", bytes: 5 * GB },
      { kind: "busy", idlePercent: 14.9 },
      { kind: "gitQueue", pending: 20 },
    ]);
  });

  test("unknown swap is not a warning", () => {
    expect(hostLoadWarnings(stats({ swapUsedBytes: null }))).toEqual([]);
  });
});

describe("buildHostOverviewRows", () => {
  test("marks the host with the fewest warnings, then the most idle cores", () => {
    const rows = buildHostOverviewRows([
      {
        serverId: "laptop",
        label: "m5-mbp-2",
        state: ready(stats({ idlePercent: 90, cores: 18 })),
      },
      {
        serverId: "studio",
        label: "mac-studio",
        state: ready(stats({ idlePercent: 60, cores: 32 })),
      },
      {
        serverId: "swapping",
        label: "m5-mbp-1",
        state: ready(stats({ idlePercent: 99, cores: 32, swapUsedBytes: 20 * GB })),
      },
    ]);

    expect(rows.filter((row) => row.isNext).map((row) => row.serverId)).toEqual(["studio"]);
  });

  test("a warned host is still picked when every host has warnings", () => {
    const rows = buildHostOverviewRows([
      { serverId: "a", label: "a", state: ready(stats({ idlePercent: 5 })) },
      { serverId: "b", label: "b", state: ready(stats({ idlePercent: 10 })) },
    ]);

    expect(rows.find((row) => row.isNext)?.serverId).toBe("b");
  });

  test("hosts without stats never take the Next badge", () => {
    const rows = buildHostOverviewRows([
      { serverId: "offline", label: "offline", state: { kind: "offline" } },
      { serverId: "old", label: "old", state: { kind: "unsupported" } },
    ]);

    expect(rows.some((row) => row.isNext)).toBe(false);
  });
});

describe("resolveHostOverviewState", () => {
  const base = { supported: true, stats: undefined, error: null };

  test("connection state wins over stats", () => {
    expect(resolveHostOverviewState({ ...base, connectionStatus: "connecting" })).toEqual({
      kind: "connecting",
    });
    expect(
      resolveHostOverviewState({ ...base, connectionStatus: "error", stats: stats({}) }),
    ).toEqual({ kind: "offline" });
  });

  test("an older daemon asks for an update instead of showing zeros", () => {
    expect(
      resolveHostOverviewState({ ...base, connectionStatus: "online", supported: false }),
    ).toEqual({ kind: "unsupported" });
    expect(supportsHostStats({ features: {} })).toBe(false);
    expect(supportsHostStats({ features: { hostStats: true } })).toBe(true);
    expect(supportsHostStats(null)).toBe(false);
  });

  test("keeps the last stats through a failed refresh", () => {
    expect(
      resolveHostOverviewState({
        ...base,
        connectionStatus: "online",
        stats: stats({}),
        error: new Error("timeout"),
      }).kind,
    ).toBe("ready");
    expect(
      resolveHostOverviewState({
        ...base,
        connectionStatus: "online",
        error: new Error("timeout"),
      }),
    ).toEqual({ kind: "failed", message: "timeout" });
  });
});

test("formats gigabytes with one decimal below 10", () => {
  expect(formatGigabytes(3.24 * GB)).toBe("3.2");
  expect(formatGigabytes(63.6 * GB)).toBe("64");
});
