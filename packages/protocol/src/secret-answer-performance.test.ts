import { expect, test } from "vitest";
import { instrumentSecretAnswer } from "../tests/instrument-secret-answer.js";
import {
  SECRET_MANAGER_PERFORMANCE_FORMS,
  SECRET_PERFORMANCE_LABELS,
  SECRET_PERFORMANCE_STRESS_FORMS,
  secretPerformanceMatrix,
  secretPerformanceText,
} from "../tests/secret-answer-performance-fixtures.js";
import { redactSecretAnswer, redactSecretPrompt } from "./secret-answer.js";

// Count actual loop iterations and helper/callback entries in a test-only copy
// of the production source. The old overlapping 4 KiB walks cost over 1,300
// steps per byte on the arrow row. These limits have no scheduler dependency.
// Absolute latency is checked separately by scripts/benchmark-secret-answer.mjs.
const WORK_PER_BYTE = 64;
const FIXED_WORK = 4_096;
const scanner = instrumentSecretAnswer();
const matrix = [...secretPerformanceMatrix()].filter((row) => row.group === "vocabulary");
const controls = [...SECRET_MANAGER_PERFORMANCE_FORMS, ...SECRET_PERFORMANCE_STRESS_FORMS];

for (const [api, redact] of scanner.readers) {
  const original = api === "prompt" ? redactSecretPrompt : redactSecretAnswer;
  test.each(controls)(`${api}: instrumented output matches production for $id`, (fixture) => {
    const text = secretPerformanceText(fixture, 4_096);
    expect(redact(text)).toBe(original(text));
  });

  test.each(SECRET_PERFORMANCE_LABELS)(
    `${api}: bounds work for every operator/value under $label`,
    ({ label }) => {
      const rows = matrix.filter((row) => row.label === label);
      expect(rows.length).toBeGreaterThan(0);
      for (const fixture of rows) {
        const text = secretPerformanceText(fixture, 4_096);
        scanner.reset();
        expect(redact(text).length).toBeGreaterThan(0);
        expect(scanner.counts().total, fixture.id).toBeLessThanOrEqual(
          WORK_PER_BYTE * text.length + FIXED_WORK,
        );
      }
    },
    60_000,
  );

  test.each(controls)(
    `${api}: scales deterministic work through 256 KB for $id`,
    (fixture) => {
      let previous = 0;
      for (const size of [64_000, 128_000, 256_000]) {
        const text = secretPerformanceText(fixture, size);
        scanner.reset();
        expect(redact(text).length).toBeGreaterThan(0);
        const work = scanner.counts().total;
        expect(work).toBeLessThanOrEqual(WORK_PER_BYTE * text.length + FIXED_WORK);
        if (previous > 0) expect(work).toBeLessThanOrEqual(previous * 2.25);
        previous = work;
      }
    },
    60_000,
  );
}
