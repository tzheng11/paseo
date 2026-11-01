import { describe, expect, test } from "vitest";
import { redactSecretAnswer, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

describe("secret answers", () => {
  test.each([
    `GOOG${"A1".repeat(10)}`,
    `AKIA${"A1".repeat(8)}`,
    `ASIA${"B2".repeat(8)}`,
    `ya29.${"a1".repeat(20)}`,
    `sk-ant-${"a1".repeat(20)}`,
    `sk-proj-${"a1_".repeat(20)}`,
    `sk-svcacct-${"b2_".repeat(20)}`,
    `sk-admin-${"c3_".repeat(20)}`,
    `sk-${"a1".repeat(20)}`,
    `impr_mcp_${"a1_".repeat(12)}`,
    `impr_oat_${"a1_".repeat(12)}`,
    ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "dtn_"].map(
      (prefix) => prefix + "a1".repeat(20),
    ),
    `eyJ${"a1".repeat(8)}.${"b2".repeat(12)}.${"c3".repeat(12)}`,
    "eyJhbGciOiJIUzI1NiJ9.e30.SYNTHETIC_SIGNATURE_12345678901234567890",
    "eyJhbGciOiJub25lIn0.e30.",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC",
  ])("withholds the complete field for a recognizable credential (%#)", (secret) => {
    const answer = `Before ${secret}+synthetic-tail after`;
    expect(redactSecretAnswer(answer)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    '"api_key": "synthetic-not-a-real-credential"',
    "'client_secret': 'synthetic-only'",
    String.raw`\"access_token\": \"SYNTHETIC1234567890\"`,
    "api_key%3Dsynthetic-only",
    "api_key%253Dsynthetic-only",
    String.raw`api_key\u003dsynthetic-only`,
    String.raw`api_key\x3dsynthetic-only`,
    "api_key&#61;synthetic-only",
    "api_key&equals;synthetic-only",
    `api_key=eyJ${"a1".repeat(8)}.${"b2".repeat(12)}.${"c3".repeat(12)}+synthetic-tail`,
    "https://example.test/?token=synthetic123-only&unrelated=keep",
    "Authorization: Bearer SYNTHETIC-NOT-A-REAL-CREDENTIAL",
    '"authorization": "Bearer SYNTHETIC-NOT-A-REAL-CREDENTIAL"',
    "relayKey=synthetic-only",
    "Bearer SYNTHETIC_12345678901234567890",
    "Basic U1lOVEhFVElDX09OTFlfTk9UX0FSRUFMX0NSRURFTlRJQUw=",
  ])("withholds quoted, encoded and suffix-bearing assignments (%#)", (answer) => {
    expect(redactSecretAnswer(answer)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    "What is the password?",
    "Paste your API key",
    "Enter the token",
    "Supply the private key",
    "Provide your passphrase",
    "Please enter your password%3A",
    "Password",
    "API key (optional)",
    "Your password:",
    "Password for the account?",
    "Mac login password?",
    "API token:",
    "**Password:**",
    "Your password please",
    "Token value:",
    "Password required",
    "API key optional:",
    "Login password needed",
    "Which API key format do you use? Enter your password",
    "Provide both API keys",
    "Paste your tokens",
    "Enter your passwords",
  ])("withholds arbitrary short values for a secret prompt (%#)", (question) => {
    expect(redactSecretAnswer("x", question)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretAnswer("123", question)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    "",
    "  Keep this whitespace.\n",
    "Blue, Green",
    "Use option 2",
    "a".repeat(40),
    "Review https://example.test/a%20b",
    "Explain what an API key is",
    "secretEnabled is true",
    "process.env.GITHUB_TOKEN",
    "Use Bearer authentication",
    "Set tokenBudget=1000",
    "refresh_token: expired",
    "secretEnabled=true",
    "Use max_tokens=4096",
    "access_token: UnauthorizedException",
    "token=invalid_or_expired",
    "token=process.env.GITHUB_TOKEN",
    "secretEnabled: false",
    '"secretEnabled": "true"',
    "process.env.SECRET_ENABLED = true",
    "token=getAccessTokenSilently()",
  ])("preserves ordinary text exactly (%#)", (answer) => {
    expect(redactSecretAnswer(answer, "Which option should we use?")).toBe(answer);
  });

  test("fails closed for oversized and deeply encoded input", () => {
    expect(redactSecretAnswer("a".repeat(65_537))).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretAnswer("x", "a".repeat(65_537))).toBe(SECRET_ANSWER_NOTICE);
    let encoded = "api_key=synthetic-only";
    for (let pass = 0; pass < 8; pass += 1) encoded = encodeURIComponent(encoded);
    expect(redactSecretAnswer(encoded)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    "Should token validation be enabled?",
    "Which token budget?",
    "What is the API key format?",
    "I fixed token validation.",
    "Please review password handling.",
  ])("preserves ordinary replies to credential discussion (%#)", (context) => {
    expect(redactSecretAnswer("yes", context)).toBe("yes");
  });

  test("a repeated redaction keeps the same notice", () => {
    expect(redactSecretAnswer(SECRET_ANSWER_NOTICE)).toBe(SECRET_ANSWER_NOTICE);
  });
});
