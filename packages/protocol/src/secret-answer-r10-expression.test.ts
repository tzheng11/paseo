import { expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const transforms = [redactSecretPrompt, redactSecretAnswer] as const;

const references = [
  "$password",
  "$userPassword",
  "$DB_PASSWORD2",
  "$1",
  "$env:DB_PASSWORD",
  "${DB_PASSWORD:-local dev}",
  "$(op read op://vault/db/password)",
] as const;

test.each(references)("preserves only a complete permitted quoted substitution: %s", (value) => {
  for (const input of [`password: "${value}"`, `{"password":"${value}"}`, `PASSWORD=${value}`]) {
    for (const transform of transforms) expect(transform(input)).toBe(input);
  }
});

const quotedLiterals = [
  "letmein!",
  "fluffy!",
  "new Fluffy",
  "dog && cat",
  "fluffy.dog",
  "fluffy()",
  "Hunter",
  "$Zx9qLm3vTq8Rb2",
  "$ummer2024",
] as const;

test.each(quotedLiterals)("treats a quoted password as a literal: %s", (value) => {
  for (const input of [
    `password: "${value}"`,
    `{"password":"${value}"}`,
    `DB_PASSWORD="${value}"`,
  ]) {
    for (const transform of transforms) {
      const result = transform(input);
      expect(result).toContain(SECRET_ANSWER_NOTICE);
      expect(result).not.toContain(value);
    }
  }
});

const safeCalls = [
  'os.getenv("DB_PASSWORD")',
  "env('API_KEY')",
  "z.string().min(1)",
  "randomBytes(32).toString('hex')",
  "value.split(':', 1)[0]",
  "trimmed.split(/\\s+/)",
  "get().catch(undefined)",
  'url.searchParams.get("password") || undefined',
  "Symbol('secret')",
  "useState('')",
  "/^(?:password|passwd)$/.test(x)",
  'Buffer.from("letmein")',
] as const;

test.each(safeCalls)("judges each safe literal argument in a reference call: %s", (value) => {
  for (const label of ["password", "token"]) {
    const input = `${label}: ${value}`;
    for (const transform of transforms) expect(transform(input)).toBe(input);
  }
});

const unsafeCalls = [
  'String("Summer2024!")',
  'String("letmein")',
  'a.get("hunter2")',
  'Buffer.from("xK9mP2vL5qRtYu3W")',
  "Welcome(123)",
  "abc(123)",
] as const;

test.each(unsafeCalls)("withholds a call that wraps a secret literal: %s", (value) => {
  const input = `password: ${value}`;
  for (const transform of transforms) {
    const result = transform(input);
    expect(result).toContain(SECRET_ANSWER_NOTICE);
    expect(result).not.toContain(value);
  }
});

const digitTypes = [
  "OAuth2Credentials",
  "OAuth2AccessToken",
  "ApiKeyV2Config",
  "Ed25519PrivateKey",
  "Sha256Digest",
  "S3Credentials",
] as const;

test.each(digitTypes)("limits digit-bearing type names to the second tier: %s", (value) => {
  for (const transform of transforms) {
    expect(transform(`token: ${value}`)).toBe(`token: ${value}`);
    expect(transform(`password: ${value}`)).toBe(`password: ${SECRET_ANSWER_NOTICE}`);
  }
});

test.each(["Summer&2024", "Welcome&123", "Monkey|2024"])(
  "does not parse a mixed literal as a type union: %s",
  (value) => {
    for (const label of ["password", "token"]) {
      const input = `${label}: ${value}`;
      for (const transform of transforms) {
        const result = transform(input);
        expect(result).toContain(SECRET_ANSWER_NOTICE);
        expect(result).not.toContain(value);
      }
    }
  },
);

test.each(["[Zx9qLm3vTq8Rb2]", "{Zx9qLm3vTq8Rb2}"])(
  "rejects random bracket contents as a reference: %s",
  (value) => {
    for (const transform of transforms) {
      expect(transform(`password: ${value}`)).toBe(`password: ${SECRET_ANSWER_NOTICE}`);
    }
  },
);

test.each([
  "password: [password]",
  "password: {{ password }}",
  "password = userPassword;",
  "password: hashed_password",
  'password: typeof x === "function"',
  "token: useCallback(",
  "tokens: tokens.map((token, tokenIndex) => ({",
  "apiKey: firstDefined<Array<string>>([",
])("preserves a named unquoted reference or code opener: %s", (input) => {
  for (const transform of transforms) expect(transform(input)).toBe(input);
});

test.each(["userPassword!", "config.password!", "process.env.DB_PASSWORD!"])(
  "preserves postfix assertions only on an independently allowed reference: %s",
  (value) => {
    for (const label of ["password", "token"]) {
      const input = `${label}: ${value}`;
      for (const transform of transforms) expect(transform(input)).toBe(input);
    }
  },
);

test.each(["AdminPass123!", "WordWord2024!"])(
  "does not rescue a literal by adding a postfix assertion: %s",
  (value) => {
    for (const label of ["password", "token"]) {
      const input = `${label}: ${value}`;
      for (const transform of transforms) {
        expect(transform(input)).toBe(`${label}: ${SECRET_ANSWER_NOTICE}`);
      }
    }
  },
);
