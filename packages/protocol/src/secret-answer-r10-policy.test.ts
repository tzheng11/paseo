import { expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const transforms = [redactSecretPrompt, redactSecretAnswer] as const;

test.each([
  "Use a bearer API/session-cookie here",
  "Basic Auth/login-flow is fine",
  "Token SDK/client-wrapper",
  "Bearer tokens are useful",
  "Token expired",
  "Matching is per-token (`scoreTextFields` splits on whitespace and every token must land in",
  "Read [Bearer authentication](https://example.test/docs/token-validation/#auth).",
  "Read [cached-token verification](https://example.test/docs/identity/#access).",
  'if (typeof options.promptPassword === "function") return;',
  'if (typeof options.promptPassword !== "string") return;',
])("keeps compound authorization prose and type comparisons: %s", (input) => {
  for (const transform of transforms) expect(transform(input)).toBe(input);
});

test("preserves a Markdown link target around a shaped authorization value", () => {
  const input = "Use [Bearer aB3dE5gH7jK9m](https://example.test/docs).";
  const expected = `Use [Bearer ${SECRET_ANSWER_NOTICE}](https://example.test/docs).`;
  for (const transform of transforms) expect(transform(input)).toBe(expected);
});

test.each(["AdminPass123!", "WordWord2024!", "WordWord123!", "Word123!"])(
  "does not parse a URL password or a quoted credential as an expression: %s",
  (value) => {
    for (const input of [
      `password: ${value}`,
      `PASSWORD=${value}`,
      `{"password":${value}}`,
      `password: "${value}"`,
      ...(value.length >= 12 ? [`token: '${value}'`, `api_key: "${value}"`] : []),
      `postgres://admin:${value}@db.example.test:5432/app`,
    ]) {
      for (const transform of transforms) {
        const output = transform(input);
        expect(output).not.toContain(value);
        expect(output).toContain(SECRET_ANSWER_NOTICE);
      }
    }
  },
);

test.each(["userPassword!", "config.password!", "process.env.FOO_API_KEY!", "Summer!"])(
  "keeps a postfix assertion only when its stem is independently allowed: %s",
  (value) => {
    for (const transform of transforms)
      expect(transform(`password: ${value}`)).toBe(`password: ${value}`);
  },
);

test.each([
  ["token: aB3dE5%41gH7j", "token: " + SECRET_ANSWER_NOTICE],
  ["token: aB3dE5gH7j", "token: aB3dE5gH7j"],
  ["password: ${DB_PASSWORD:-local dev}", "password: ${DB_PASSWORD:-local dev}"],
  ["PASSWORD=$(op read op://vault/db/password)", "PASSWORD=$(op read op://vault/db/password)"],
])("uses raw length and preserves balanced substitutions: %s", (input, expected) => {
  for (const transform of transforms) expect(transform(input)).toBe(expected);
});

test.each([
  '--password "fluffy()"',
  '--secret "read(config)"',
  '--api-key "read(config)"',
  "--api-key aB3dE5%41gH7j",
  "--secret aB3dE5%41gH7j",
])("applies literal quotes and raw length to existing flag routes: %s", (input) => {
  for (const transform of transforms) expect(transform(input)).toContain(SECRET_ANSWER_NOTICE);
});

test.each([
  '--password "${DB_PASSWORD}"',
  "--api-key process.env.API_KEY",
  '--api-key "${API_KEY}"',
  "--secret read(config)",
])("preserves permitted references on existing flag routes: %s", (input) => {
  for (const transform of transforms) expect(transform(input)).toBe(input);
});
