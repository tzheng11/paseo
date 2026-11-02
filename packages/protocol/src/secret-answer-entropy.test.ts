import { describe, expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const SYNTHETIC = "aB3dE7gH9kL2mN5pQ8rTsU1vW4xY6zA0";

function expectKept(text: string): void {
  expect(redactSecretPrompt(text)).toBe(text);
  expect(redactSecretAnswer(text, "Which one should I use?")).toBe(text);
}

describe("entropy boundaries retain routing syntax and identifier segments", () => {
  test.each([
    "ISS-5527-claude-quota-reload-fix-v2",
    "Fashion-B7-001-Wool-Coat",
    "scratch/PROJ-143-Mgr/run7/out-final-2.json",
    "flow-state.test.ts:123",
    "typescript@5.4.2-beta.1",
    "fix-login-6d8cd2a",
    "run-20261102T0159Z-output",
    "run-20261102T015945Z-output",
    "20261102T0159Z",
    "20261102T015945Z",
    "prefix40bb71dd-7bc7-81c1-8159-ddd32c74c0b1",
    "40bb71dd-7bc7-81c1-8159-ddd32c74c0b1suffix",
    "https://example.test/a/Path@segment/another,segment-end",
    "https://example.test/a/Path@segment/another,segment-end?next=/home",
    "Abcdefghijklmn/pqrstuvwxyzabcdefghijklmn",
  ])("keeps %s", expectKept);

  test.each([
    `routing/${SYNTHETIC}/file.txt`,
    `routing-${SYNTHETIC}-file`,
    `https://example.test/path?token=${SYNTHETIC}&next=/home`,
    `https://example.test/path?a=1,{"x":"${SYNTHETIC}"}`,
  ])("detects an independent opaque segment in %s", (text) => {
    expect(redactSecretPrompt(text)).toContain(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(text)).not.toContain(SYNTHETIC);
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(redactSecretPrompt(text));
  });

  test.each([
    "cachedRunningUnderARM64Translation",
    "detectRunningUnderARM64Translation",
    "Char123LocaleChar125GlmRouteImport",
    "MountedRecentStreamItemsE2ETestGlobals",
  ])("the strict numeric identifier predicate retains %s", (value) => {
    expectKept(value);
    expectKept(`const x = ${value};`);
  });

  test("a wholly opaque base64 value retains its full slash-delimited span", () => {
    const value = "/q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8x9C0v1B2n3M4";
    expect(redactSecretPrompt(value)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretAnswer(value, "Which one should I use?")).toBe(SECRET_ANSWER_NOTICE);
  });

  test("an at-sign in a URL path does not invent a password", () => {
    const text = `https://example.test/route:segment/${SYNTHETIC}@another/path,more`;
    expectKept(text);
  });

  test("a URL's exemption continues through commas but its query remains scanned", () => {
    const text = `https://example.test/a,${SYNTHETIC}?token=${SYNTHETIC}&next=/home`;
    expect(redactSecretPrompt(text)).toBe(
      `https://example.test/a,${SYNTHETIC}?token=${SECRET_ANSWER_NOTICE}&next=/home`,
    );
  });

  test("cookie shape length is measured before decoding", () => {
    const text = "Cookie: session=aB3dE5%41gH7j; Path=/";
    expect(redactSecretPrompt(text)).toBe(`Cookie: session=${SECRET_ANSWER_NOTICE}; Path=/`);
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(redactSecretPrompt(text));
    expectKept("Cookie: session=aB3dE5AgH7j; Path=/");
  });

  test("a real userinfo password can contain a slash or hash", () => {
    const password = "Ab3dE5/gH7jK9#mN1pQ3";
    const text = `postgres://user:${password}@host.test/db`;
    expect(redactSecretPrompt(text)).toBe(`postgres://user:${SECRET_ANSWER_NOTICE}@host.test/db`);
  });

  test.each(["hX7P@JbJhZ#I", "1#wUqVQY^*!j", "fvzh%@?BqY~3", "1/Ab3dE5gH7jK"])(
    "userinfo retains the last at-sign boundary for synthetic value %s",
    (value) => {
      const text = `postgres://alice:${value}@example.test/db`;
      expect(redactSecretPrompt(text)).toBe(
        `postgres://alice:${SECRET_ANSWER_NOTICE}@example.test/db`,
      );
      expect(redactSecretAnswer(text, "Which one should I use?")).toBe(redactSecretPrompt(text));
    },
  );

  test.each([
    "https://localhost:443/path@segment/next",
    "https://example.test:443/path@segment/next",
    "https://127.0.0.1:443/path@segment/next",
  ])("a URL port with an at-sign in its path stays %s", expectKept);

  test("simple letter path is narrow: a plus or random casing keeps the secret classification", () => {
    for (const value of [
      "AbCdEfGhIjKlMnOpQrSt/UvWxYzAbCdEfGhIjKlM",
      "Abcdefghijklmn+pqrstuvwxyzabcdefghijklmn",
    ]) {
      expect(value).toHaveLength(40);
      expect(redactSecretPrompt(value)).toBe(SECRET_ANSWER_NOTICE);
      expect(redactSecretAnswer(value, "Which one should I use?")).toBe(SECRET_ANSWER_NOTICE);
    }
  });
});
