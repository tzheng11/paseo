import { expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const referenceExpressions = [
  "Math.round(tokenCount / 1000)",
  "tabs.filter((candidate) => candidate !== current)",
  "values.filter((value): value is string => typeof value === 'string')",
  "calc((tokens + other) * scale)",
  "tabs.filter((candidate) => (candidate !== current))",
] as const;

test.each(referenceExpressions)("preserves a complete reference expression: %s", (expression) => {
  const input = `password: ${expression}`;
  expect(redactSecretPrompt(input)).toBe(input);
  expect(redactSecretAnswer(input)).toBe(input);
});

const literalOrOpaqueExpressions = [
  "String(32/2)",
  "String('a'+'b')",
  "String(['V'])",
  "read((value):string=>String('synthetic-secret'))",
  "xK9mP2.vL5qRt",
  "xK9mP2/vL5qRt",
] as const;

test.each(literalOrOpaqueExpressions)(
  "withholds literal-only calls and opaque expression-shaped values: %s",
  (expression) => {
    const input = `password: ${expression}`;
    const expected = `password: ${SECRET_ANSWER_NOTICE}`;
    expect(redactSecretPrompt(input)).toBe(expected);
    expect(redactSecretAnswer(input)).toBe(expected);
  },
);

// Expected outcomes were frozen from ac106c225 before adding shared parse summaries.
// The 4096-byte parser window can end inside a token; its synthetic EOF is significant.
function expressionAtCutoff(tail: string, consumedTail: number): string {
  const unit = "alpha => ";
  const beforeTail = 4096 - consumedTail;
  const count = Math.floor(beforeTail / unit.length);
  return unit.repeat(count) + " ".repeat(beforeTail - count * unit.length) + tail;
}

test.each([
  ["partial word", "undefined => omega", 4, true],
  ["complete keyword", "undefined => omega", 9, false],
  ["partial arrow operator", "omega => omega", 7, true],
  ["complete arrow operator", "omega => omega", 8, false],
  ["partial conjunction operator", "omega && omega", 7, true],
  ["complete conjunction operator", "omega && omega", 8, false],
] as const)("preserves the exact 4096-byte cutoff for %s", (_name, tail, consumed, kept) => {
  const expression = expressionAtCutoff(tail, consumed);
  const input = `password: ${expression}`;
  const expected = kept ? input : `password: ${SECRET_ANSWER_NOTICE}${expression.slice(5)}`;
  expect(redactSecretPrompt(input)).toBe(expected);
  expect(redactSecretAnswer(input)).toBe(expected);
});

test.each([
  ["alpha && beta || gamma ?? delta", true],
  ["alpha => beta === omega", true],
  ["alpha === beta => omega", false],
  ["alpha => true && false || null ?? omega", true],
  ["alpha => beta => undefined", false],
  ["alpha => beta + omega", false],
  ["alpha=32 ${setting:-local dev}", true],
  ["alpha beta ${setting:-local dev}", false],
  ["alpha => beta ${setting:-local dev}", true],
  ["alpha => read(config)", true],
  ["alpha => foo() || beta", true],
  ["alpha => foo(beta === omega) || false", true],
  ["alpha => config.value ?? false", true],
  ["alpha => (beta || false) ?? false", true],
  ["alpha ? beta => false : false", true],
  ["false ? alpha => false : false", false],
  ["alpha => true ? false : false", false],
  ["alpha ? false : beta => false", false],
  ["false ? alpha : beta => omega", true],
] as const)("keeps flat-run and complex fallback behavior for %s", (expression, kept) => {
  const input = `password: ${expression}`;
  const firstWordEnd = expression.search(/\s/);
  const expected = kept
    ? input
    : `password: ${SECRET_ANSWER_NOTICE}${expression.slice(firstWordEnd)}`;
  expect(redactSecretPrompt(input)).toBe(expected);
  expect(redactSecretAnswer(input)).toBe(expected);
});

test("parse summaries belong to one human-message scan", () => {
  const reference = "password: alpha => omega";
  const literal = "password: alpha => false";
  const withheld = `password: ${SECRET_ANSWER_NOTICE} => false`;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    expect(redactSecretPrompt(reference)).toBe(reference);
    expect(redactSecretPrompt(literal)).toBe(withheld);
    expect(redactSecretAnswer(reference)).toBe(reference);
    expect(redactSecretAnswer(literal)).toBe(withheld);
  }
});
