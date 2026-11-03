import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  redactSecretAnswer,
  redactSecretPrompt,
  secretPromptSpans,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

const commit = createHash("sha1").update("synthetic-sha-input").digest("hex");
const neutralWrappedControls = [
  "`src/foo-1.ts`",
  "src/foo-1.ts",
  "`~/.config/app-2/`:",
  "(`packages/util/a1.ts`).",
  "`brands/x/y-1.ts:12`",
  `\`${commit}\`.`,
  commit,
  `\`${commit}\`:`,
  "`123e4567-e89b-12d3-a456-426614174000`.",
  "123e4567-e89b-12d3-a456-426614174000",
  "a/b/flow-state.ts:123",
  "src/foo/bar/flow.ts:9",
  "fix-login-d8cd2a6",
  "worker-f2a3-retry-queue",
  "MAX_CONCURRENT_JOBS=true",
  "toBase64UrlString",
  "createOAuth2Client",
  "useS3MultipartUpload",
  "encodeUtf8ToBase64",
  "X509CertificateInfo",
  "sha256HexDigestOf",
  "ipv4AddressPattern",
  "h264VideoEncoderConfig",
  "Migration20261101Add",
  "testCase123Handler",
  "ArrowDown10Icon",
  "'ArrowDown10Icon',",
  "fooBarBazV2,",
  "release-notes-v2.",
  "gpt-4-turbo-preview.",
  "gpt-4-turbo-preview",
  "`src/foo-bar-1.ts`",
  "src/foo-bar-1.ts",
  "(`src/foo-bar-1.ts`).",
  "`docs/foo/bar-1.md`,",
  "docs/foo/bar-1.md",
  "fooBarBazQuxV2Thing,",
  "fooBarBazQuxV2Thing",
  "'ArrowDownAZ10Icon',",
  "ArrowDownAZ10Icon",
  "`ArrowDownAZ10Icon`",
  "ArrowDownAZ10Icon.",
  "release-notes-final-v2.",
  "release-notes-final-v2",
  "`release-notes-final-v2`",
];

// At 61d6a790 these 26 synthetic controls were already withheld as neutral
// structured answers. N does not add a new requirement to classify their bare
// forms; their existing byte-exact chat behavior remains covered.
const priorNeutralMisses = [
  "src/(a1)/conn/oauth/flow.ts",
  "flow-state.test.ts:123",
  "`flow-state.test.ts:123`",
  "flow.ts:1200-1240",
  "a/flow-state.ts:123",
  "10-stack-patterns.md",
  "2026-10-12-foo-bar.md",
  "01-architecture-notes",
  "2026_11_01_add_table",
  "FASHION-BOOT-001",
  "PROJ-143-MGR-42-A",
  "ISS-5527-RELOAD-FIX",
  "ISS-5527-claude-quota-fix",
  "Fashion-B7-001-Wool",
  "fix-login-6d8cd2a",
  "worker-3f2a-retry-queue",
  "|col_name_12|1|0|",
  "|a1|b2|c3|d4|e5|f6|",
  "MAX_CONCURRENT_JOBS=8",
  "--max-old-space-size=4096",
  "NODE_ENV=production1",
  "region=us-east1-b-zone",
  "typescript@5.4.2-beta.1",
  "@scope/pkg-name@1.2.3",
  "checkpoint12345678",
  "[ISS-123](https://x.y/z)",
];

describe("N ordinary wrappers and punctuation", () => {
  test.each(neutralWrappedControls)("keeps ordinary control %# byte-exact", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(text);
  });

  test.each(priorNeutralMisses)("retains pre-existing chat behavior %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });

  test.each([
    "sk-ant-api03-" + "Synthetic1NotARealCredential".repeat(3),
    "sk-proj-" + "Synthetic1NotARealCredential".repeat(3),
    "sntryu_" + "Synthetic1NotARealCredential".repeat(3),
  ])("wrapping an explicit credential does not make it ordinary %#", (value) => {
    for (const text of [`\`${value}\`.`, `(${value}).`, `'${value}',`]) {
      expect(redactSecretAnswer(text, "Which one should I use?")).toBe(
        text.replace(value, SECRET_ANSWER_NOTICE),
      );
      expect(redactSecretPrompt(text)).not.toContain(value);
    }
  });
});

const syntheticPayload = "Synthet1cNotARealCredent1al".repeat(6);
const wrappedCredentials = [
  { kind: "Anthropic", value: "sk-ant-api03-" + syntheticPayload },
  { kind: "OpenAI", value: "sk-proj-" + syntheticPayload },
  { kind: "Sentry sntrys", value: "sntrys_" + syntheticPayload },
  { kind: "Sentry sntryu", value: "sntryu_" + syntheticPayload },
  { kind: "GCS access ID", value: "GOOG" + "SYNTHET1CNOTAREALCREDENTIAL".repeat(6) },
  { kind: "SendGrid", value: "SG." + syntheticPayload.slice(0, 22) + "." + syntheticPayload },
];
const wrappedCases = wrappedCredentials.flatMap(({ kind, value }) =>
  ["\n", "\r\n"].flatMap((newline) =>
    Array.from({ length: 41 }, (_, index) => ({
      kind,
      width: 40 + index,
      newline,
      lineEnding: newline === "\n" ? "LF" : "CRLF",
      value,
    })),
  ),
);

describe("O a known credential can continue over one line ending", () => {
  test.each(wrappedCases)(
    "withholds the entire $kind at width $width over $lineEnding",
    ({ value, width, newline }) => {
      const wrapped = value.slice(0, width) + newline + value.slice(width);
      const text = `Before ${wrapped}${newline}Next step: run tests.`;
      expect(secretPromptSpans(text)).toEqual([{ start: 7, end: 7 + wrapped.length }]);
      expect(redactSecretPrompt(text)).toBe(
        `Before ${SECRET_ANSWER_NOTICE}${newline}Next step: run tests.`,
      );
      expect(redactSecretAnswer(text)).toBe(
        `Before ${SECRET_ANSWER_NOTICE}${newline}Next step: run tests.`,
      );
    },
  );

  test.each(wrappedCredentials)("preserves prose after a complete $kind", ({ value }) => {
    for (const newline of ["\n", "\r\n"]) {
      const text = `Before ${value}${newline}Next step: run tests.`;
      expect(redactSecretPrompt(text)).toBe(
        `Before ${SECRET_ANSWER_NOTICE}${newline}Next step: run tests.`,
      );
    }
  });
});
