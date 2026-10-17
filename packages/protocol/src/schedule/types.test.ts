import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, ScheduleRunSchema } from "./types.js";

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("ScheduleRunSchema", () => {
  const legacy = {
    id: "old-run",
    scheduledFor: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    status: "succeeded",
    agentId: null,
    output: "ok",
    error: null,
  };
  test("parses old run records without adding skip metadata", () => {
    expect(ScheduleRunSchema.parse(legacy)).toEqual(legacy);
  });
  test("preserves optional skipReason with the existing status values", () => {
    const skipped = { ...legacy, status: "failed", skipReason: "agent busy" };
    expect(ScheduleRunSchema.parse(skipped)).toEqual(skipped);
  });
});
