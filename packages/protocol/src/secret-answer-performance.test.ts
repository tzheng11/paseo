import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt } from "./secret-answer.js";

// All inputs are synthetic, including the cookie and key-like values. A null
// budget requires linear scaling only; the two explicit throughput budgets are
// the Manager's ordinary-text and hostile-density limits on the shared host.
const forms = [
  ["P1 unquoted cookies", "Cookie: ", "a=b;", 1_500],
  ["P1 set-cookie", "Set-Cookie: ", "sid=abc1;", 1_500],
  ["P1 quoted cookies", "Cookie: ", 'a="b";', 1_500],
  ["P1 dense cookie fields", "cookie:1;", "a=b;c=d;", 1_500],
  ["P1 shaped cookies", "Cookie: ", "sid=abcdef123456;", 1_500],
  ["P2 data labels", "", "data:", 1_500],
  ["P2 data values", "", "data:x;", 1_500],
  ["P2 minified data objects", "", '{data:a,type:"x",id:1},', 1_500],
  ["P3 repeated provider prefixes", "", "sk-ant-", 1_500],
  ["P4 token-only known-key lines", "", "sk-ant-aB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gH\n", 1_500],
  ["one-line prose", "", "ordinary prose containing no values, ", 1_500],
  [
    "one curly-quoted password then prose",
    "password: “fluffy” ",
    "ordinary prose containing no values, ",
    1_500,
  ],
  ["repeated unclosed curly password", "", "password: “a ", null],
  ["repeated password open paren", "", "password: ( ", null],
  ["repeated password open brace", "", "password: { ", null],
  ["repeated token open paren", "", "token: ( ", null],
  ["repeated unmatched shell substitution", "", "password: $( a ", null],
  ["repeated unmatched template substitution", "", "password: ${ a ", null],
  ["repeated token substitution", "", "token: $( a ", null],
  ["password paren and comma at line end", "", "password: (a,\n", null],
  ["token paren and comma at line end", "", "token: (a,\n", null],
  ["opener followed by long body", "password: (", `${"a".repeat(32)} `, null],
  ["key chain with short continuation", "", "password: a.b.c( ", null],
  ["unfinished define literal", "", 'define("a",', null],
  ["unrelated copula", "", "x is ", null],
  ["dense API key labels", "", "api key: ", 3_000],
  ["dense setter labels", "", 'setPassword("', 3_000],
  ["dense spaced table cells", "", "| password | a |\n", 3_000],
  ["dense JSON labels", "", '{"password":"a"},', 3_000],
  ["dense token cookies", "Cookie: ", "token=abcdef123456;", 3_000],
  ["dense query tokens", "?token=", "a&token=", 3_000],
  ["nested parentheses", "password: ", "(", 3_000],
  ["dense password equals quote", "", "password='", 3_000],
] as const;

const readers = [
  ["prompt", redactSecretPrompt],
  ["answer", redactSecretAnswer],
] as const;
const sizes = [256_000, 512_000, 1_000_000] as const;

function measure(redact: (text: string) => string, text: string): number {
  const timings: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const started = performance.now();
    const result = redact(text);
    timings.push(performance.now() - started);
    // A length assertion proves completion without printing a megabyte result.
    expect(result.length).toBeGreaterThan(0);
  }
  // Taking the best of three removes unrelated scheduler pauses on a shared
  // host. Every sample still executes the complete scanner and output builder.
  return Math.min(...timings);
}

for (const [api, redact] of readers) {
  test.each(forms)(
    `${api}: scans %s linearly through one MB`,
    (_name, prefix, unit, budget) => {
      redact(prefix + unit.repeat(Math.ceil(32_000 / unit.length)));
      let previous: number | null = null;
      for (const size of sizes) {
        const text = prefix + unit.repeat(Math.ceil((size - prefix.length) / unit.length));
        const elapsed = measure(redact, text);
        if (previous !== null) {
          expect(elapsed / previous, `${size} bytes: ${elapsed.toFixed(1)} ms`).toBeLessThanOrEqual(
            2.5,
          );
        }
        if (budget !== null) {
          expect(elapsed, `${text.length} bytes: ${elapsed.toFixed(1)} ms`).toBeLessThanOrEqual(
            budget * (text.length / 1_000_000),
          );
        }
        previous = elapsed;
      }
    },
    60_000,
  );
}
