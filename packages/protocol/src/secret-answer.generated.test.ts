import { describe, expect, test } from "vitest";
import identifierSnapshot from "../tests/secret-answer-identifiers.json" with { type: "json" };
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const SEED = 0x06389143;
const LENGTHS = [20, 32, 40, 64];
// Test-only measurement manifest: random-secret protection takes precedence for these ambiguous identifiers.
// This data is never imported by the runtime detector.
// Reviewed ruling-10 losses: neutral values carrying ambiguous digit tags.
// At 16–31 characters, preserving these names raises the random-secret residue beyond its bar.
const K1_WITHHELD = {
  bareChat: [],
  code: [],
  neutralAnswer: [
    "BottomAnchorE2ETestGlobals",
    "Char123LocaleChar125GlmRoute",
    "ConnectionOfferV2",
    "E2EECapabilities",
    "E2EEHelloMessage",
    "E2EEReadyMessage",
    "I18nErrorReporter",
    "I18nLanguageController",
    "Pcm16MonoResampler",
    "V2RuntimeOptions",
    "base64ToUint8Array",
    "createRelayE2eeTransportFactory",
    "daemonPublicKeyB64",
    "ensureI18nLanguageForRender",
    "float32ToPcm16le",
    "getUtf8ByteLength",
    "initReactI18next",
    "isE2EECapabilities",
    "isE2EEHelloMessage",
    "isE2EEReadyMessage",
    "isRunningUnderARM64Translation",
    "parsePcm16MonoWav",
    "pcm16LeToAudioBuffer",
    "pcm16leToFloat32",
    "runningUnderARM64Translation",
    "supportsJsonlRpcProtocolV2",
    "toBase64UrlNoPad",
  ],
};
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

/** Standard mulberry32; generate full base62 candidates and reject non-letter-led/non-mixed ones. */
function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed = (seed + 0x6d2b79f5) >>> 0);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function* mixedTokens(random: () => number, length: number, count: number): Generator<string> {
  let accepted = 0;
  while (accepted < count) {
    let value = "";
    while (value.length < length) value += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
    if (
      !/^[A-Za-z]/.test(value) ||
      !/[A-Z]/.test(value) ||
      !/[a-z]/.test(value) ||
      !/\d/.test(value)
    )
      continue;
    accepted += 1;
    yield value;
  }
}

/** Forty-character standard-base64 values with slash and all three alphanumeric classes. */
function* mixedBase64Tokens(
  random: () => number,
  count: number,
  withDigits = true,
): Generator<string> {
  const alphabet = `${withDigits ? ALPHABET : ALPHABET.slice(0, 52)}+/`;
  let accepted = 0;
  while (accepted < count) {
    let value = "";
    while (value.length < 40) value += alphabet[Math.floor(random() * alphabet.length)]!;
    if (
      !(withDigits ? value.includes("/") : /[+/]/.test(value)) ||
      !/[A-Z]/.test(value) ||
      !/[a-z]/.test(value) ||
      (withDigits && !/\d/.test(value))
    )
      continue;
    accepted += 1;
    yield value;
  }
}

function allPositionFailures(values: Iterable<string>) {
  const failures = {
    password: residue(),
    secret: residue(),
    apiKey: residue(),
    token: residue(),
    pass: residue(),
    neutralAnswer: residue(),
    bareChat: residue(),
  };
  for (const value of values) {
    const candidates = [
      { text: `password: ${value}`, failures: failures.password },
      { text: `secret=${value}`, failures: failures.secret },
      { text: `api_key: ${value}`, failures: failures.apiKey },
      { text: `token="${value}"`, failures: failures.token },
      { text: `pass: ${value}`, failures: failures.pass },
    ];
    for (const candidate of candidates)
      if (
        redactSecretPrompt(candidate.text) !== candidate.text.replace(value, SECRET_ANSWER_NOTICE)
      )
        recordFailure(candidate.failures, value);
    if (redactSecretAnswer(value, "Which one should I use?") !== SECRET_ANSWER_NOTICE)
      recordFailure(failures.neutralAnswer, value);
    if (redactSecretPrompt(value) !== SECRET_ANSWER_NOTICE) recordFailure(failures.bareChat, value);
  }
  return failures;
}

function reviewerBatches(): GeneratedBatch[] {
  const random = mulberry32(0x6389);
  return LENGTHS.map((length) => ({ length, values: [...mixedTokens(random, length, 20_000)] }));
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
  test("keeps explicit constants and short syllabic camel-case names", () => {
    for (const identifier of [
      "BASE64_WORKSPACE_ID_PREFIX",
      "testSuite1234",
      "Uint8Array",
      "S3Client",
    ]) {
      expect(redactSecretPrompt(identifier), identifier).toBe(identifier);
      expect(redactSecretAnswer(identifier, "Which one should I use?"), identifier).toBe(
        identifier,
      );
    }
  });
  test.each(generatedBatches())(
    "protects $length characters in every required value position",
    ({ length, values }) => {
      const failures = {
        password: residue(),
        secret: residue(),
        apiKey: residue(),
        token: residue(),
        pass: residue(),
        neutralAnswer: residue(),
        bareChat: residue(),
      };
      for (const value of values) {
        const labelled = [
          { text: `password: ${value}`, failures: failures.password },
          { text: `secret=${value}`, failures: failures.secret },
          { text: `api_key: ${value}`, failures: failures.apiKey },
          { text: `token="${value}"`, failures: failures.token },
          { text: `pass: ${value}`, failures: failures.pass },
        ];
        for (const candidate of labelled) {
          if (
            redactSecretPrompt(candidate.text) !==
            candidate.text.replace(value, SECRET_ANSWER_NOTICE)
          )
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

describe("M1 reviewer and independent distribution regression matrices", () => {
  test.each(reviewerBatches())(
    "protects reviewer mulberry32 $length-character values",
    ({ length, values }) => {
      const failures = {
        password: residue(),
        secret: residue(),
        apiKey: residue(),
        token: residue(),
        pass: residue(),
        neutralAnswer: residue(),
        bareChat: residue(),
      };
      for (const value of values) {
        const candidates = [
          { text: `password: ${value}`, failures: failures.password },
          { text: `secret=${value}`, failures: failures.secret },
          { text: `api_key: ${value}`, failures: failures.apiKey },
          { text: `token="${value}"`, failures: failures.token },
          { text: `pass: ${value}`, failures: failures.pass },
        ];
        for (const candidate of candidates)
          if (
            redactSecretPrompt(candidate.text) !==
            candidate.text.replace(value, SECRET_ANSWER_NOTICE)
          )
            recordFailure(candidate.failures, value);
        if (redactSecretAnswer(value, "Which one should I use?") !== SECRET_ANSWER_NOTICE)
          recordFailure(failures.neutralAnswer, value);
        if (length >= 32 && redactSecretPrompt(value).includes(value))
          recordFailure(failures.bareChat, value);
      }
      for (const [position, result] of Object.entries(failures))
        expect(
          result,
          `${position}: ${result.count}/20000 forwarded; mulberry32 seed=0x6389`,
        ).toEqual(residue());
    },
    30_000,
  );

  test("meets pooled neutral rates over three independent seeds and reports each seed", () => {
    const pooledNeutral = new Map<number, number>([
      [20, 0],
      [24, 0],
    ]);
    const perSeed: { seed: number; length: number; neutral: number; chat: number }[] = [];
    for (const seed of [0x91e10da5, 0x243f6a88, 0xb7e15162]) {
      const random = mulberry32(seed);
      for (const length of [20, 24, 32, 40, 64]) {
        const failures = { neutralAnswer: residue(), bareChat: residue() };
        const password = residue();
        for (const value of mixedTokens(random, length, 100_000)) {
          if (redactSecretPrompt(`password: ${value}`) !== `password: ${SECRET_ANSWER_NOTICE}`)
            recordFailure(password, value);
          if (redactSecretAnswer(value, "Which one should I use?") !== SECRET_ANSWER_NOTICE)
            recordFailure(failures.neutralAnswer, value);
          if (length >= 32 && redactSecretPrompt(value).includes(value))
            recordFailure(failures.bareChat, value);
        }
        expect(password, `password: seed=${seed}; length=${length}`).toEqual(residue());
        perSeed.push({
          seed,
          length,
          neutral: failures.neutralAnswer.count,
          chat: failures.bareChat.count,
        });
        if (length < 32) {
          pooledNeutral.set(
            length,
            (pooledNeutral.get(length) ?? 0) + failures.neutralAnswer.count,
          );
        } else {
          expect(
            failures.neutralAnswer.count,
            `neutral: seed=${seed}; length=${length}`,
          ).toBeLessThanOrEqual(1);
          expect(
            failures.bareChat.count,
            `chat: seed=${seed}; length=${length}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    console.info("M1 independent rates", JSON.stringify({ countPerSeed: 100_000, perSeed }));
    for (const [length, count] of pooledNeutral) {
      expect(
        count,
        `pooled neutral length=${length}: ${count}/300000; per-seed=${JSON.stringify(perSeed)}`,
      ).toBeLessThanOrEqual(15);
    }
  }, 360_000);
});

describe("I forty-character base64-with-slash regression matrix", () => {
  test.each([
    { seed: 0x6389, count: 20_000, withDigits: true },
    { seed: 0x6389, count: 20_000, withDigits: false },
    { seed: 0x91e10da5, count: 100_000, withDigits: true },
    { seed: 0x91e10da5, count: 100_000, withDigits: false },
    { seed: 0x243f6a88, count: 100_000, withDigits: true },
    { seed: 0x243f6a88, count: 100_000, withDigits: false },
    { seed: 0xb7e15162, count: 100_000, withDigits: true },
    { seed: 0xb7e15162, count: 100_000, withDigits: false },
  ])(
    "protects every value position for seed $seed over $count values (digits=$withDigits)",
    ({ seed, count, withDigits }) => {
      const failures = allPositionFailures(mixedBase64Tokens(mulberry32(seed), count, withDigits));
      for (const [position, result] of Object.entries(failures))
        expect(result, `${position}: ${result.count}/${count} forwarded; seed=${seed}`).toEqual(
          residue(),
        );
    },
    120_000,
  );
});

describe("K1 checked-in repository identifier snapshot", () => {
  test("records exact conservative losses and keeps every other identifier byte-exact", () => {
    const failures = {
      bareChat: [] as string[],
      code: [] as string[],
      neutralAnswer: [] as string[],
    };
    for (const identifier of identifierSnapshot.identifiers) {
      if (redactSecretPrompt(identifier) !== identifier) failures.bareChat.push(identifier);
      const code = `const x = ${identifier};`;
      if (redactSecretPrompt(code) !== code) failures.code.push(identifier);
      if (redactSecretAnswer(identifier, "Which one should I use?") !== identifier)
        failures.neutralAnswer.push(identifier);
    }
    expect(identifierSnapshot.identifiers).toHaveLength(identifierSnapshot.count);
    expect(identifierSnapshot.files).toBeGreaterThan(0);
    for (const position of ["bareChat", "code", "neutralAnswer"] as const) {
      expect(
        failures[position],
        `${position}: ${failures[position].length}/${identifierSnapshot.count} changed`,
      ).toEqual(K1_WITHHELD[position]);
    }
  });

  test("keeps the required syntax controls after numeric-tag calibration", () => {
    for (const value of [
      "ArrowDownAZ10Icon",
      "fooBarBazQuxV2Thing",
      "Button2Component.tsx",
      "Http2SessionManager.ts",
      "BlockV2Serializer",
      "toBase64UrlString",
      "createOAuth2Client",
      "X509CertificateInfo",
      "h264VideoEncoderConfig",
      "Grid2x2CheckIcon",
      "x509CertToPem2Chain",
      "EC2InstanceTypeG4dnXLarge",
      "Gpt4oMini20240718Model",
      "see src/main/java/com/acme/auth/OAuth2LoginController.java now",
    ]) {
      expect(redactSecretPrompt(value), value).toBe(value);
      expect(redactSecretAnswer(value, "Which one should I use?"), value).toBe(value);
    }
  });
});
