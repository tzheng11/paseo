import { describe, expect, test } from "vitest";
import identifierSnapshot from "../tests/secret-answer-identifiers.json" with { type: "json" };
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";
import { isWordlikeIdentifier } from "./secret-answer.js";

const SEED = 0x06389143;
const LENGTHS = [20, 32, 40, 64];
const PER_LENGTH = 2_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

interface GeneratedBatch {
  length: number;
  values: string[];
}

/** xorshift32, letter-led uniform base62; reject candidates missing any of upper/lower/digit. */
function generatedBatches(): GeneratedBatch[] {
  let state = SEED;
  function random(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  }
  return LENGTHS.map((length) => {
    const values: string[] = [];
    while (values.length < PER_LENGTH) {
      let value = ALPHABET[Math.floor(random() * 52)]!;
      while (value.length < length) value += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
      const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
      if (mixed) values.push(value);
    }
    return { length, values };
  });
}

interface Residue {
  count: number;
  examples: string[];
}

function residue(): Residue {
  return { count: 0, examples: [] };
}

function recordFailure(failures: Residue, value: string): void {
  failures.count += 1;
  if (failures.examples.length < 10) failures.examples.push(value);
}

describe("M1 seeded synthetic mixed-base62 regression matrix", () => {
  test("recognizes explicit constant boundaries and short syllabic camel-case names", () => {
    for (const identifier of [
      "BASE64_WORKSPACE_ID_PREFIX",
      "testSuite1234",
      "Uint8Array",
      "S3Client",
    ]) {
      expect(isWordlikeIdentifier(identifier), identifier).toBe(true);
    }
  });
  test.each(generatedBatches())(
    "protects $length characters in every required value position",
    ({ length, values }) => {
      const failures = {
        wordlike: residue(),
        secret: residue(),
        apiKey: residue(),
        token: residue(),
        pass: residue(),
        neutralAnswer: residue(),
        bareChat: residue(),
      };
      for (const value of values) {
        if (isWordlikeIdentifier(value)) recordFailure(failures.wordlike, value);
        const labelled = [
          { text: `secret=${value}`, failures: failures.secret },
          { text: `api_key: ${value}`, failures: failures.apiKey },
          { text: `token="${value}"`, failures: failures.token },
          { text: `pass: ${value}`, failures: failures.pass },
        ];
        for (const candidate of labelled) {
          if (redactSecretPrompt(candidate.text).includes(value))
            recordFailure(candidate.failures, value);
        }
        if (redactSecretAnswer(value, "Which one should I use?") !== SECRET_ANSWER_NOTICE) {
          recordFailure(failures.neutralAnswer, value);
        }
        if (length >= 32 && redactSecretPrompt(value).includes(value))
          recordFailure(failures.bareChat, value);
      }
      expect(values).toHaveLength(PER_LENGTH);
      for (const [position, result] of Object.entries(failures)) {
        expect(
          result,
          `${position}: ${result.count}/${PER_LENGTH} forwarded; seed=${SEED}`,
        ).toEqual(residue());
      }
    },
  );
});

describe("K1 checked-in repository identifier snapshot", () => {
  test("keeps every harvested identifier byte-exact in all three required positions", () => {
    const failures = { bareChat: residue(), code: residue(), neutralAnswer: residue() };
    for (const identifier of identifierSnapshot.identifiers) {
      if (redactSecretPrompt(identifier) !== identifier)
        recordFailure(failures.bareChat, identifier);
      const code = `const x = ${identifier};`;
      if (redactSecretPrompt(code) !== code) recordFailure(failures.code, identifier);
      if (redactSecretAnswer(identifier, "Which one should I use?") !== identifier) {
        recordFailure(failures.neutralAnswer, identifier);
      }
    }
    expect(identifierSnapshot.identifiers).toHaveLength(identifierSnapshot.count);
    expect(identifierSnapshot.files).toBeGreaterThan(0);
    for (const [position, result] of Object.entries(failures)) {
      expect(result, `${position}: ${result.count}/${identifierSnapshot.count} changed`).toEqual(
        residue(),
      );
    }
  });
});
