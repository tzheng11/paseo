import { expect, test } from "vitest";
import {
  DEFAULT_NATIVE_MAX_TRACKED_ENTRIES,
  resolveNativeInventoryLimit,
} from "./native-recursive-limits.js";

const gib = 1024 ** 3;

test("native inventory keeps its existing default without an override", () => {
  expect(resolveNativeInventoryLimit({}, () => 2 * gib)).toBe(1_000_000);
  expect(DEFAULT_NATIVE_MAX_TRACKED_ENTRIES).toBe(1_000_000);
});

test("native inventory accepts bounded operator limits and requires heap headroom for growth", () => {
  expect(
    resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: "500000" }, () => 2 * gib),
  ).toBe(500_000);
  expect(
    resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: "1000000" }, () => 2 * gib),
  ).toBe(1_000_000);
  expect(
    resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: "2000000" }, () => 16 * gib),
  ).toBe(2_000_000);
  expect(() =>
    resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: "2000000" }, () => 8 * gib),
  ).toThrow(/16 GiB/);
  expect(() =>
    resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: "1000001" }, () => Number.NaN),
  ).toThrow(/16 GiB/);
});

test.each(["", "0", "-1", "1.5", "2e6", "NaN", "Infinity", "2000001", "9007199254740993"])(
  "native inventory rejects invalid or unvalidated entry limit %j",
  (value) => {
    expect(() =>
      resolveNativeInventoryLimit({ PASEO_NATIVE_MAX_TRACKED_ENTRIES: value }, () => 16 * gib),
    ).toThrow(/PASEO_NATIVE_MAX_TRACKED_ENTRIES/);
  },
);
