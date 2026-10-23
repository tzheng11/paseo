import { expect, test } from "vitest";
import { workerHeapDiagnostics } from "./worker-heap-diagnostics.js";

test("worker heap diagnostics whitelist heap fields when the execution flag is unknown", () => {
  expect(
    workerHeapDiagnostics({
      execArgv: ["--inspect", "--import=private-loader"],
      heapSizeLimitBytes: 4 * 1024 ** 3,
    }),
  ).toEqual({ maxOldSpaceSizeMiB: null, heapSizeLimitMiB: 4096 });
});

test.each(["16384", "65536"])(
  "worker heap diagnostics report a known %s MiB flag and actual limit",
  (heap) => {
    expect(
      workerHeapDiagnostics({
        execArgv: [`--max-old-space-size=${heap}`],
        heapSizeLimitBytes: (Number(heap) + 48) * 1024 ** 2,
      }),
    ).toEqual({ maxOldSpaceSizeMiB: Number(heap), heapSizeLimitMiB: Number(heap) + 48 });
  },
);

test("worker heap diagnostics report the last explicit heap setting", () => {
  expect(
    workerHeapDiagnostics({
      execArgv: ["--max-old-space-size=16384", "--max-old-space-size", "65536"],
      heapSizeLimitBytes: 65584 * 1024 ** 2,
    }),
  ).toEqual({ maxOldSpaceSizeMiB: 65536, heapSizeLimitMiB: 65584 });
});
