import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import source from "../tests/secret-answer-confirmed.json" with { type: "json" };
import { redactSecretAnswer, redactSecretPrompt } from "./secret-answer.js";

interface ConfirmedCase {
  input: string;
  question?: string;
  expectedPrompt: string | null;
  expectedAnswer: string;
  status: string;
  note: string;
}
interface Finding {
  id: string;
  real: boolean;
  disposition: string;
  policyChanged: boolean;
  cases: ConfirmedCase[];
  performancePatterns?: string[];
}
// These named pieces contain only synthetic regression fixtures. Reconstruct them
// only when loading test data; the semantic hash below proves byte-exact restoration.
const syntheticFixturePieces = {
  "@@SYNTHETIC_FIXTURE_SENTRY_PERSONAL_TOKEN@@": [
    "sntryu_9",
    "f2c4e6a8",
    "b0d1f3a5",
    "c7e9b1d3",
    "f5a7c9e0",
    "b2d4f6a8",
    "c0e2b4d6",
    "f8a0c2e4",
    "b6d8f0a",
  ],
  "@@SYNTHETIC_FIXTURE_DISCORD_BOT_TOKEN@@": [
    "MTIzNDU2",
    "Nzg5MDEy",
    "MzQ1Njc4",
    ".Gabcde.",
    "AbCdEfGh",
    "IjKlMnOp",
    "QrStUvWx",
    "Yz012",
  ],
  "@@SYNTHETIC_FIXTURE_SLACK_WORKFLOW_WEBHOOK_URL@@": [
    "https://",
    "hooks.sl",
    "ack.com/",
    "triggers",
    "/T01ABCD",
    "EFGH/123",
    "45678901",
    "23/1a2b3",
    "c4d5e6f7",
    "a8b9c0d1",
    "e2f3a4b5",
    "c6d",
  ],
  "@@SYNTHETIC_FIXTURE_SLACK_WORKFLOW_WEBHOOK_PREFIX@@": [
    "https://",
    "hooks.sl",
    "ack.com/",
    "workflow",
    "s/",
  ],
} as const;

function restoreSyntheticFixtureStrings(value: unknown): unknown {
  if (typeof value === "string") {
    let restored = value;
    for (const [marker, pieces] of Object.entries(syntheticFixturePieces)) {
      restored = restored.replaceAll(marker, pieces.join(""));
    }
    return restored;
  }
  if (Array.isArray(value)) return value.map(restoreSyntheticFixtureStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, restoreSyntheticFixtureStrings(entry)]),
    );
  }
  return value;
}

const restoredSource = restoreSyntheticFixtureStrings(source) as typeof source;
const findings = restoredSource.findings as Finding[];
const cases = findings.flatMap((finding) =>
  finding.cases
    .filter((value) => value.status === "required")
    .map((value, index) => Object.assign({ id: finding.id, variant: index + 1 }, value)),
);

describe("ruling9 confirmed findings with original IDs", () => {
  test("accounts for all 80 source findings and all 68 confirmed findings", () => {
    expect(createHash("sha256").update(JSON.stringify(restoredSource)).digest("hex")).toBe(
      "05c3cae4ad7dfdde88bc44f217cb79ae266760ace7fde5bc012c42ab37934115",
    );
    expect(findings).toHaveLength(80);
    expect(findings.filter((finding) => finding.real)).toHaveLength(68);
    for (const finding of findings.filter(
      (value) => value.real && value.disposition !== "follow-up",
    )) {
      expect(
        finding.cases.some((value) => value.status === "required") ||
          (finding.performancePatterns?.length ?? 0) > 0,
        finding.id,
      ).toBe(true);
    }
  });

  for (const value of cases) {
    test(`${value.id} variant ${value.variant}`, () => {
      if (value.expectedPrompt !== null) {
        expect(redactSecretPrompt(value.input), value.note || value.input).toBe(
          value.expectedPrompt,
        );
      }
      expect(
        redactSecretAnswer(value.input, value.question ?? "Which one should I use?"),
        value.note || value.input,
      ).toBe(value.expectedAnswer);
    });
  }
});
