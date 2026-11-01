import { describe, expect, test } from "vitest";
import {
  redactSecretAnswer,
  redactSecretPrompt,
  secretPromptSpans,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

describe("credential value grammar", () => {
  test.each([
    ["token = hunter2x", "token = "],
    ["secret=hunter", "secret="],
    ["api_key: orange", "api_key: "],
    ["credential: x", "credential: "],
    ["pass: hunter2x", "pass: "],
  ])("withholds ordinary-shaped literals under credential keys: %s", (text, prefix) => {
    expect(redactSecretPrompt(text!)).toBe(prefix + SECRET_ANSWER_NOTICE);
    expect(redactSecretAnswer(text!)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    'password: "string | null"',
    "password: string | null;",
    'password: "PascalCase | undefined"',
    "key: hunter2x",
    "password: cfg.password",
    "pass: 3 tests",
    "GCS HMAC: gcloud storage hmac create for the same service account",
    "Http2SessionManager.ts",
  ])("keeps types and reference syntax: %s", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });

  test.each(['token = "hunter2x rest stays', "token = 'hunter2x\nnext line stays"])(
    "an unmatched value quote stops at the next whitespace: %s",
    (text) => {
      expect(redactSecretPrompt(text)).toBe(text.replace("hunter2x", SECRET_ANSWER_NOTICE));
    },
  );

  test.each(["export PASSWORD=hunter2x&&make deploy", "export PASSWORD=hunter2x|cat"])(
    "keeps the next shell operator: %s",
    (text) => {
      expect(redactSecretPrompt(text)).toBe(text.replace("hunter2x", SECRET_ANSWER_NOTICE));
    },
  );
});

// K2 keeps the ordinary controls from both review verdicts and ruling 6.
// The newer B/C policy intentionally supersedes password-discussion free
// structured replies and `pass: first`; their protection tests live next door.
const keptCases = [
  ["interface property type", "interface Login { password: string; }"],
  ["password type", "password: string"],
  ["password reference", "password: hashedPassword"],
  ["numeric dependency pin", "pin: 3.11"],
  ["quoted dependency pin", '"pin": "^1.2.3"'],
  ["storage key", 'storageKey: "web-indexeddb-0001"'],
  ["idempotency key", "idempotencyKey: req_2026_11_01_0001"],
  ["quoted label rename", 'Rename the "Password:" label to "Passcode:" in LoginForm.tsx'],
  [
    "quoted label followed by a new line",
    'Click the "Password:" field, then check the footer.\nAfter that, run the tests.',
  ],
  [
    "quoted label followed by a literal newline escape",
    String.raw`Click the "Password:" field, then check the footer.\nAfter that, run the tests.`,
  ],
  ["model option", "claude-sonnet-5-5"],
  ["release option", "release-2026-11-01"],
  ["issue branch option", "iss-6389-secret-answers"],
  ["region option", "us-east-1-production"],
  ["container option", "postgres-16-alpine"],
  ["UTC timestamp", "2026-11-01T21:40:48Z"],
  ["email option", "user2@example-company.com"],
  ["component filename", "Button2Component.tsx"],
  ["test filename", "agent-message2.test.ts"],
  ["dotted config option", "config.region2.default"],
  ["version option", "v2026.11.01-beta.2"],
  ["timestamp offset", "2026-11-01T21:40:48+00:00"],
  ["timestamp with milliseconds", "2026-11-01T21:40:48.123-0600"],
  ["ordinary lowercase slug", "blue7-ocean3-tiger9"],
  ["workspace ID", "wks_9a12e95ee4e4af87"],
  ["project ID", "prj_44e33a8ea8d50705"],
  ["task ID", "task_9A12E95EE4E4AF87"],
  ["long workspace ID", "wks_9a12e95ee4e4af879A12E95EE4E4AF87"],
  ["S3 path", "Please fix packages/server/src/aws/S3Client/upload.ts"],
  ["OAuth2 path", "see src/main/java/com/acme/auth/OAuth2LoginController.java now"],
  ["serializer identifier", "rename AgentPromptContentBlockV2Serializer please"],
  ["private key type", "const privateKey: Uint8Array = load()"],
  ["credentials type", "credentials: OAuth2Credentials"],
  ["secret name camel case", "secretName: tls-cert-2024"],
  ["secret name snake case", "secret_name: prod-db-credentials-2"],
  [
    "credential file path",
    "credentials_file: /Users/me/.config/gcloud/application_default_credentials.json",
  ],
  [
    "credential environment file path",
    "GOOGLE_APPLICATION_CREDENTIALS=/etc/app/service_account_credentials.json",
  ],
  ["API key call", "const apiKey = getApiKey1234(config)"],
  ["ordinary secretary field", "secretary: John2Smith"],
  ["pass count", "pass: 3 tests"],
  ["pass placeholder", "pass = required"],
  ["pass identifier", "pass: testSuite1234"],
  ["pass call", "pass: getApiKey1234(config)"],
  ["token call", "token = getApiKey1234(config)"],
  ["dotted secret reference", "secret = config.apiKey1234"],
  ["dotted API key reference", "apiKey: config.apiKey1234"],
  ["ordinary token count", "const tokenCount: number = countTokens(text)"],
  ["API key name", "apiKeyName: openai-prod-key-2"],
  ["password policy", "password_policy: min12chars"],
  ["secret manager project", "SECRET_MANAGER_PROJECT=impower-production"],
  ["password hash type", "passwordHash: Argon2Hasher"],
  ["credential path reference", "credentialsPath = ~/.config/gcloud/adc2.json"],
  ["Base64 path", "open src/features/s3Upload/Base64Encoder2.ts"],
  ["UTF identifier", "the class Utf8ToUtf16Converter is slow"],
  ["digit in app path", "run brands/hyperbola/apps/web2/src/app/page.tsx"],
  ["hash helper names", "use the md5Sum and sha1Digest helpers"],
  ["short chat gap", "use aB3dE7gH9kL2mN5pQ8rT here"],
  ["bare key with symbols", "key: Zq8!rT2$wX5&nB7k after"],
  ["bare key with dots", "key = Zq8.rT2$wX5&nB7k after"],
  ["password typed array reference", "password=Uint8Array"],
  ["password function reference", "password=getApiKey1234(config)"],
  ["long ordinary local path", "/Users/tim/Development/importantWorkspace2026/anotherFile12345.ts"],
  [
    "encoded Unicode image Markdown",
    "Emit settled assistant image Markdown: ![Encoded destination image](/private/var/folders/d9/hy1jfhyj777cr2cb7wzsq8h00000gn/T/agent-tab-image-stability-N6asqz/My%20image%20%D0%9C%D0%BE%D0%B8.png)",
  ],
  [
    "encoded Unicode local image",
    "/Users/tim/Development/source/S3Client/My%20image%20%D0%9C%D0%BE%D0%B8.png",
  ],
  [
    "encoded Unicode relative image",
    "assets/generated/agent-tab-image-stability-N6asqz/My%20image%20%D0%9C%D0%BE%D0%B8.png",
  ],
  ["Unicode local image", "/Users/tim/source/My image Мои.png"],
  ["Unicode relative image", "assets/generated/My image Мои.png"],
  ["literal percent image", "/Users/tim/source/literal%20filename.png"],
  ["ordinary git SHA", "41c4e4c0bd7709490212ac97f0beda98ae2812ad"],
  ["ordinary UUID", "bc299fea-5481-48e4-bb5f-31fc299789a1"],
  ["environment reference", "apiKey: process.env.ANTHROPIC_API_KEY"],
  ["shell references", "password=$DB_PASSWORD and token=${GITHUB_TOKEN}"],
  ["template references", "secret: {{ secrets.FOO }} and password: <your password>"],
  ["Python environment reference", 'api_key = os.environ["ANTHROPIC_API_KEY"]'],
  ["image data URI", "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAA".repeat(40)],
  ["package integrity", "integrity sha512-" + "Zm9vYmFyYmF6".repeat(7) + "=="],
] as const;

describe("K2 ordinary bytes remain exact", () => {
  test.each(keptCases)("keeps %s in chat and a neutral structured answer", (_name, text) => {
    expect(secretPromptSpans(text)).toEqual([]);
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text, "Which option should we use?")).toBe(text);
  });

  test.each([
    "Design token for the primary color?",
    "Design tokens:",
    "GPIO pins for the LED strip?",
    "Pin for the dependency?",
  ])("keeps the region answer to ambiguous terminology: %s", (question) => {
    expect(redactSecretPrompt("us-east-1", question)).toBe("us-east-1");
    expect(redactSecretAnswer("us-east-1", question)).toBe("us-east-1");
  });

  test.each([
    "Token",
    "Enter token",
    "Paste your tokens",
    "Provide the secret",
    "What is the secret for this host?",
    "key",
    "pin",
  ])("does not infer credentials from an unqualified noun: %s", (question) => {
    expect(redactSecretPrompt("hunter2x", question)).toBe("hunter2x");
    expect(redactSecretAnswer("hunter2x", question)).toBe("hunter2x");
  });

  test.each(["", "yes", "no", "YES", "No"])(
    "keeps the exact B exception under password discussion (%#)",
    (answer) => {
      const question = "Should I rotate the database password now?";
      expect(redactSecretPrompt(answer, question)).toBe(answer);
      expect(redactSecretAnswer(answer, question)).toBe(answer);
    },
  );
});

describe("K2 credential spans keep URL and shell terminators", () => {
  test.each([
    {
      name: "URL query next parameter",
      text: "https://example.test/cb?token=SYNTHETIC1234567890&next=/home",
      value: "SYNTHETIC1234567890",
    },
    {
      name: "shell command after a semicolon",
      text: "export PASSWORD=hunter2x;make deploy",
      value: "hunter2x",
    },
    {
      name: "literal shell terminator after a punctuated value",
      text: "password=punct!#&?;:()",
      value: "punct!#&?",
    },
  ])("redacts just the credential before $name", ({ text, value }) => {
    const start = text.indexOf(value);
    expect(secretPromptSpans(text)).toEqual([{ start, end: start + value.length }]);
    expect(redactSecretPrompt(text)).toBe(text.replace(value, SECRET_ANSWER_NOTICE));
    expect(redactSecretAnswer(text, "Anything else?")).toBe(SECRET_ANSWER_NOTICE);
  });
});
