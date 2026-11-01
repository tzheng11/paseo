import { describe, expect, test } from "vitest";
import {
  redactSecretAnswer,
  redactSecretPrompt,
  secretPromptSpans,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

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
    '"api_key": "SYNTHETIC123_NOT_A_REAL_CREDENTIAL"',
    "'client_secret': 'SYNTHETIC1234567890'",
    String.raw`\"access_token\": \"SYNTHETIC1234567890\"`,
    "api_key%3DSYNTHETIC1234567890",
    "api_key%253DSYNTHETIC1234567890",
    String.raw`api_key\u003dSYNTHETIC1234567890`,
    String.raw`api_key\x3dSYNTHETIC1234567890`,
    "api_key&#61;SYNTHETIC1234567890",
    "api_key&equals;SYNTHETIC1234567890",
    `api_key=eyJ${"a1".repeat(8)}.${"b2".repeat(12)}.${"c3".repeat(12)}+synthetic-tail`,
    "https://example.test/?token=synthetic123-only&unrelated=keep",
    "Authorization: Bearer SYNTHETIC-NOT-A-REAL-CREDENTIAL",
    '"authorization": "Bearer SYNTHETIC-NOT-A-REAL-CREDENTIAL"',
    "relayKey=SYNTHETIC1234567890",
    "Bearer SYNTHETIC_12345678901234567890",
    "Basic U1lOVEhFVElDX09OTFlfTk9UX0FSRUFMX0NSRURFTlRJQUw=",
  ])("withholds quoted, encoded and suffix-bearing assignments (%#)", (answer) => {
    expect(redactSecretAnswer(answer)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    "What is the password?",
    "Paste your API key",
    "Enter the auth token",
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
    "Token",
    "Password required",
    "API key optional:",
    "Login password needed",
    "Which API key format do you use? Enter your password",
    "Provide both API keys",
    "Paste your auth tokens",
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

  test("scans the complete input without redacting harmless oversized text", () => {
    const ordinary = "log line without anything sensitive in it\n".repeat(1_800);
    expect(redactSecretAnswer(ordinary)).toBe(ordinary);
    expect(redactSecretPrompt(ordinary)).toBe(ordinary);
    expect(redactSecretAnswer("x", "a".repeat(65_537))).toBe("x");
    let encoded = "api_key=SYNTHETIC1234567890";
    for (let pass = 0; pass < 8; pass += 1) encoded = encodeURIComponent(encoded);
    expect(redactSecretAnswer(encoded)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    "Should token validation be enabled?",
    "Which token budget?",
    "What is the API key format?",
    "I fixed token validation.",
    "Please review password handling.",
    "Enter token",
    "Paste your tokens",
    "What is a password?",
  ])("preserves ordinary replies to credential discussion (%#)", (context) => {
    expect(redactSecretAnswer("yes", context)).toBe("yes");
  });

  test("a repeated redaction keeps the same notice", () => {
    expect(redactSecretAnswer(SECRET_ANSWER_NOTICE)).toBe(SECRET_ANSWER_NOTICE);
  });
});

const ordinaryAssistantMessages = [
  "I'll send the key findings next.",
  "What is the key difference between these two options?",
  "I need to check which tokens the model used.",
  "Which key should I use for the React list?",
  "Which keys do you want in the JSON output?",
  "Do you need the token count broken down by model?",
  "Let me know what you think about the key rotation order.",
  "I will share the secrets scan results once it finishes.",
  "The IC needs a password-free route, so what next?",
  "Done. Tests pass.",
];
const ordinaryPrompts = [
  "The secret-scan: required check failed on this PR, please look.",
  "Tim kept these holds, credentials: anything that uses a key.",
  "Set GCS_AGENT_FILES_HMAC_SECRET_KEY: placeholder in the example file.",
  "In the schema, password: required for local accounts only.",
  "Fix this yaml:\n  secretName: my-app-config\n  image: nginx",
  "Why does this fail? const client = new S3({ accessKeyId: process.env.KEY_ID })",
  "authorization: Bearer token goes in the header, see the docs.",
  "log line without anything sensitive in it\n".repeat(1_800),
  "log line without anything sensitive in it\n".repeat(1_400),
  "See %2525252520 please",
  "api_key=$API_KEY",
  "api_key=${API_KEY}",
  "api_key=<your-api-key>",
];

describe("Manager ordinary-input regression battery", () => {
  test.each(ordinaryAssistantMessages)("A: ordinary context %#", (context) => {
    expect(redactSecretAnswer("yes go ahead", context)).toBe("yes go ahead");
    expect(redactSecretPrompt("yes go ahead", context)).toBe("yes go ahead");
  });
  test.each(ordinaryPrompts)("B: ordinary prompt %#", (text) => {
    expect(redactSecretAnswer(text)).toBe(text);
    expect(redactSecretPrompt(text)).toBe(text);
  });
  test.each([
    ["password: correct-horse-battery", undefined],
    ["sk-ant-" + "a".repeat(40), undefined],
    ["hunter2", "Enter your Mac password"],
    ["hunter2", "Password"],
  ])("D: synthetic secret protection %#", (text, context) => {
    expect(redactSecretAnswer(text!, context)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(text!, context)).not.toBe(text);
  });
});

describe("general prompt spans", () => {
  test("preserves prose, keys, separators, quotes and terminal punctuation exactly", () => {
    const secret = "sk-ant-" + "a".repeat(40);
    const text = `Before ${secret}. Next\n"api_key": "SYNTHETIC1234567890" after`;
    expect(redactSecretPrompt(text)).toBe(
      `Before ${SECRET_ANSWER_NOTICE}. Next\n"api_key": "${SECRET_ANSWER_NOTICE}" after`,
    );
  });
  test("preserves authorization schemes and redacts their value only", () => {
    const text = "authorization: Bearer SYNTHETIC1234567890 after";
    expect(redactSecretPrompt(text)).toBe(`authorization: Bearer ${SECRET_ANSWER_NOTICE} after`);
  });
  test("maps encoded secret spans to original UTF-16 offsets", () => {
    const value = "SYNTHETIC1234567890";
    const text = `😀 before api_key%253D${value} after`;
    const start = text.indexOf(value);
    expect(secretPromptSpans(text)).toEqual([{ start, end: start + value.length }]);
    expect(redactSecretPrompt(text)).toBe(`😀 before api_key%253D${SECRET_ANSWER_NOTICE} after`);
  });
  test("removes oversized literal tails without touching surrounding text", () => {
    const secret = "sk-proj-" + "A1_".repeat(30_000);
    expect(redactSecretPrompt(`Before ${secret} after`)).toBe(
      `Before ${SECRET_ANSWER_NOTICE} after`,
    );
  });
  test("finds secrets near the end of a large ordinary prompt", () => {
    const prefix = "ordinary line\n".repeat(20_000);
    const secret = "sk-ant-" + "a".repeat(40);
    expect(redactSecretPrompt(prefix + secret + " end")).toBe(
      prefix + SECRET_ANSWER_NOTICE + " end",
    );
  });
  test("only uses final-message requests for a single token reply without surrounding whitespace", () => {
    expect(redactSecretPrompt("hunter2", "Earlier result. Please enter your password:")).toBe(
      SECRET_ANSWER_NOTICE,
    );
    expect(redactSecretPrompt("hunter2", "Enter your password. Done now.")).toBe("hunter2");
    expect(redactSecretPrompt("hunter2\n", "Password")).toBe("hunter2\n");
    expect(redactSecretPrompt("hunter2 more", "Password")).toBe("hunter2 more");
    expect(redactSecretPrompt("hunter2", "What's your API key?")).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt("hunter2", "What is a password?")).toBe("hunter2");
  });
  test("detects an incomplete PEM body after an ordinary label", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDX09OTFlfTk9UX1JFQUxfQ1JFREVOVElBTA==";
    expect(redactSecretPrompt("Private key: " + key)).toBe("Private key: " + SECRET_ANSWER_NOTICE);
  });
});
