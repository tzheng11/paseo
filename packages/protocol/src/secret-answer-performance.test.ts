import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { redactSecretPrompt } from "./secret-answer.js";

const forms = [
  ["P1 unquoted cookies", "Cookie: ", "a=b;"],
  ["P1 set-cookie", "Set-Cookie: ", "sid=abc1;"],
  ["P1 quoted cookies", "Cookie: ", 'a="b";'],
  ["P1 dense cookie fields", "cookie:1;", "a=b;c=d;"],
  ["P1 shaped cookies", "Cookie: ", "sid=abcdef123456;"],
  ["P2 data labels", "", "data:"],
  ["P2 data values", "", "data:x;"],
  ["P2 minified data objects", "", '{data:a,type:"x",id:1},'],
  ["P3 repeated provider prefixes", "", "sk-ant-"],
  ["P4 token-only known-key lines", "", "sk-ant-aB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gH\n"],
] as const;

test.each(forms)("scans one MB of %s within 1.5 seconds", (_name, prefix, unit) => {
  const text = prefix + unit.repeat(Math.ceil((1_000_000 - prefix.length) / unit.length));
  redactSecretPrompt(prefix + unit.repeat(2_000));
  const started = performance.now();
  const result = redactSecretPrompt(text);
  const elapsed = performance.now() - started;
  // These values are synthetic. A length assertion avoids logging the large
  // result while ensuring the scanner actually completed and returned text.
  expect(result.length).toBeGreaterThan(0);
  expect(elapsed, `${elapsed.toFixed(1)} ms for ${text.length} bytes`).toBeLessThanOrEqual(
    1_500 * (text.length / 1_000_000),
  );
});
