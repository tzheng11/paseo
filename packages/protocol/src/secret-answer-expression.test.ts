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
