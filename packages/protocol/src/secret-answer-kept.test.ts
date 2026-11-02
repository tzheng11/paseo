import { describe, expect, test } from "vitest";
import {
  redactSecretAnswer,
  redactSecretPrompt,
  secretPromptSpans,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

describe("credential value grammar", () => {
  test.each(["token = hunter2x", "secret=hunter", "api_key: orange", "credential: x"])(
    "keeps short unshaped values under non-password credential keys: %s",
    (text) => {
      expect(redactSecretPrompt(text)).toBe(text);
      expect(redactSecretAnswer(text)).toBe(text);
    },
  );

  test("withholds an ordinary-shaped value under a password-family key", () => {
    const text = "pass: hunter2x";
    expect(redactSecretPrompt(text)).toBe("pass: " + SECRET_ANSWER_NOTICE);
    expect(redactSecretAnswer(text)).toBe("pass: " + SECRET_ANSWER_NOTICE);
  });

  test.each([
    'password: "string | null"',
    "password: string | null;",
    'password: "PascalCase | undefined"',
    "key: hunter2x",
    "password: cfg.password",
    "GCS HMAC: gcloud storage hmac create for the same service account",
    "Http2SessionManager.ts",
  ])("keeps types and reference syntax: %s", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });

  test.each(['password = "hunter2x rest stays', "password = 'hunter2x\nnext line stays"])(
    "an unmatched value quote stops at the next whitespace: %s",
    (text) => {
      expect(redactSecretPrompt(text)).toBe(text.replace("hunter2x", SECRET_ANSWER_NOTICE));
    },
  );

  test.each(["export PASSWORD=hunter2x&&make deploy", "export PASSWORD=hunter2x|cat"])(
    "preserves shell operators after a contiguous credential assignment: %s",
    (text) => {
      const expected = text.replace("hunter2x", SECRET_ANSWER_NOTICE);
      expect(redactSecretPrompt(text)).toBe(expected);
      expect(redactSecretAnswer(text)).toBe(expected);
    },
  );
});

// K2 retains the ordinary controls that are consistent with Manager ruling9.
// Inputs superseded by its tiers, local reader, operators, and expression grammar
// remain explicit in the policy-change matrix below.
const keptCases = [
  ["interface property type", "interface Login { password: string; }"],
  ["password type", "password: string"],
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
  ["S3 path", "Please fix packages/server/src/aws/S3Client/upload.ts"],
  ["OAuth2 path", "see src/main/java/com/acme/auth/OAuth2LoginController.java now"],
  ["serializer identifier", "rename AgentPromptContentBlockV2Serializer please"],
  ["private key type", "const privateKey: Uint8Array = load()"],
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

  test.each(["Token", "Enter token", "Paste your tokens", "key", "pin"])(
    "does not infer credentials from an unqualified noun: %s",
    (question) => {
      expect(redactSecretPrompt("hunter2x", question)).toBe("hunter2x");
      expect(redactSecretAnswer("hunter2x", question)).toBe("hunter2x");
    },
  );

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
    expect(redactSecretAnswer(text, "Anything else?")).toBe(
      text.replace(value, SECRET_ANSWER_NOTICE),
    );
  });
});

const ordinaryCodeAndProse = {
  equality: [
    "if (token === 'abc') return;",
    "if (apiKey == null) throw e;",
    "typeof input.refreshToken === 'string'",
    "if (token !== 'abc') return;",
    "items.map(token => token.id)",
  ],
  parameterTypes: [
    "function sign(token: string): string {",
    "const f = (secret: string): boolean => true;",
    "function sign(token: string) {",
    "sign(token: string, n: number): void {",
  ],
  openers: [
    "credentials: {",
    "token: {",
    "export type AccessToken = {",
    "password: { label: 'x' },",
    "secret: [",
    "export type Creds = (",
    "export type ResolveCredentials = (",
  ],
  functionTypes: [
    "getAccessToken: () => string;",
    "setPin: (c, id) => go(c, id),",
    "readonly credential: () => Promise<string>;",
  ],
  membersAndIndexes: [
    "const token = res.data?.token;",
    "const apiKey = process.env[name];",
    "const token = parts[0];",
    "const secret = cfg.secret;",
    "const apiKey = process.env.API_KEY;",
  ],
  nonNull: ["apiKey: process.env.FOO_API_KEY!,", "privateKey: signingKey!,"],
  chainedCalls: ["token: getToken(),", "secret: a.b(c).d,"],
  callArguments: [
    "const token = read(data, 'x');",
    "const accessToken = getValue(record, 'access_token');",
  ],
  keywords: [
    "const token = typeof raw === 'string' ? raw : null;",
    "const secret = new Foo();",
    "credentials: readonly Cred[];",
    "const pass = !failed && ok;",
    "const token = await getToken();",
    "const token = block && block.id;",
  ],
  templates: ["headers: { authorization: `Bearer ${apiToken}` },", "const token = `${a}.${b}`;"],
  nonCredentialKeys: [
    "const SHORTCUT_KEY = 'mod+k';",
    "const OFFSET_KEY = 'offset';",
    "const STORAGE_KEY = 'theme';",
    "const LOCAL_KEY = 'abc';",
  ],
  ordinaryPins: [
    "// THE PIN: base tip and head tip",
    "export type ReviewPin = Pick<A, 'b'>;",
    "safety_pin: 'x',",
    "Date-only pin=2026-10-12; expiry advances",
    "- **Failed on an older pin:** superseded",
  ],
  prose: [
    "Verify the token: the signature must match.",
    "authorization: the reviewer decides.",
    "this needs a credential: name, owner, purpose",
    "Expired API key: rotate via its issuer.",
    "the password is stored in a vault",
    "when an API key is provided, the client retries",
    "throw new Error('Current password is incorrect.');",
    "throw new Error('Foo API key is required.');",
    "the API key is required",
    "the password is required.",
  ],
  emphasis: ["- **The token:** lives in tokens.ts", "- **Authorization:** reviewers decide"],
  documentationClosers: [
    "the token rides as a `?token=` query param",
    "for example `AUTH_SECRET=`.",
    "`persist-credentials: false`.",
  ],
  placeholders: [
    "ANTHROPIC_API_KEY=... pnpm test",
    "password: '…'",
    "{ api_key: 'sk-...' }",
    "token=xxx",
    "API_KEY=your-api-key",
    "token: YOUR_TOKEN",
    "API_KEY=<your-key>",
    "token=${TOKEN}",
  ],
  shellReferences: [
    "export GH_TOKEN=$(gh auth token)",
    'GH_TOKEN="$(gh auth token)" pnpm x',
    '-H "X-API-Key: $API_KEY"',
    `sh -c 'curl -H "X-API-Key: $API_KEY" http://x'`,
    '--token "$TOKEN"',
    'curl -H "Authorization: Bearer $TOKEN" x',
    'export GH_TOKEN="$(gh auth token)"',
    "export GH_TOKEN=$GITHUB_PAT",
  ],
  fetchEnums: ["credentials: 'include',", "credentials: 'same-origin',", "  credentials: 'omit',"],
  icon: ["secret: '㊙',"],
  slugs: [
    "Row Fashion-B7-001-Wool-Coat-Polyester-Blend was captured",
    "Branch ISS-5527-claude-quota-reload-fix-v2 merged",
    "see FMB-Proxy-iss1234-a1b2c3d4e-99zzz here",
  ],
  paths: [
    "Screenshot at .local/ISS-1234/aB3dE/foo-bar-123.png today",
    "see scratch/PROJ-143-Mgr/run7/out-final-2.json now",
  ],
  summary: ["Results Tests12/Files3/Suites4/Lint0/Types0/Docs2/Spec9 all pass"],
  authorizationDiscussion: [
    "loader-provided basic metadata-driven/page-ui content",
    "Mobile bearer app/session-cookie, full run",
    "a basic configuration-management tool",
  ],
  repeatedSeparators: ["api-key:: Abcd1234Efgh5678", "password== Abcd1234Efgh5678"],
};

describe("K2 H ordinary code and prose grammar", () => {
  const cases = Object.entries(ordinaryCodeAndProse).flatMap(([kind, inputs]) =>
    inputs.map((text, index) => ({ kind, index, text })),
  );
  test.each(cases)("keeps $kind case $index", ({ text }) => {
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(text);
  });

  const digest = "f870a9a8104a7d8e7a301c9b15572cc89687608adb341c2339c448b1cf5adc95";
  const commit = "6d78cd0aa8db83e9387603ecbcfd0e4a55c86781";
  test.each([
    `digest SHA256${digest} ok`,
    `digest SHA-256${digest} ok`,
    `digest sha256:${digest} ok`,
    `digest sha256-${digest} ok`,
    `digest ${digest} ok`,
    `commit ${commit} ok`,
    `commit SHA${commit} ok`,
  ])("keeps synthetic digest context %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(text);
  });
});

describe("K2 K ordinary last-assistant statements", () => {
  const replies = ["ok", "continue", "lgtm", "go", "2", "thanks!"];
  test.each([
    "I fixed the password reset bug in auth.ts and added three tests. All 42 pass. Should I continue with the settings page?",
    "Done. The API key is now read from process.env in config.ts.",
    "Should I rotate the API key?",
  ])("keeps all six short chat replies after statement %#", (context) => {
    for (const reply of replies) expect(redactSecretPrompt(reply, context)).toBe(reply);
  });

  test.each([
    "I fixed the password reset bug in auth.ts.",
    "Please enter your password:",
    "What is your API key?",
  ])("keeps a slash command even under credential context %#", (context) => {
    expect(redactSecretPrompt("/compact", context)).toBe("/compact");
  });
});

describe("H strong code contexts retain bindings and incomplete call openers", () => {
  test.each([
    "return { token: text, displayOnly: false };",
    "const { apiKey: discarded, ...rest } = config;",
    "const token = response;",
    "const token = resolve({",
  ])("keeps strong source syntax %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });

  test.each([
    ["password=xK(9#mP2", "xK(9#mP2"],
    ["const password=xK(9#mP2", "xK(9#mP2"],
    ["token: firstDefined<9#mP2>([", "firstDefined<9#mP2>(["],
    ["return { token: secretValue123456, other: false }", "secretValue123456"],
  ])("keeps C/G protection when strong reference proof is absent %#", (text, value) => {
    const start = text!.lastIndexOf(value!);
    expect(redactSecretPrompt(text!)).toBe(
      text!.slice(0, start) + SECRET_ANSWER_NOTICE + text!.slice(start + value!.length),
    );
  });
});

// Ruling9 rules1-4 supersede these earlier K2 keeps. The explicit matrix retains
// the old inputs and proves that only the locally read value changes.
describe("ruling9 changes to earlier K2 keeps", () => {
  test.each([
    ["password: hashedPassword", "hashedPassword"],
    ["pass: 3 tests", "3"],
    ["pass = required", "required"],
    ["pass: only that file was rerun", "only"],
    ['`{"pass": 34}`', "34"],
    ["password=changeme", "changeme"],
    ["token:= Abcd1234Efgh5678", "Abcd1234Efgh5678"],
    ["const token = client.getToken(", "client.getToken("],
    ["apiKey: firstDefined<string>([", "firstDefined<string>(["],
    ["apiKey: firstDefined<Array<string>>([", "firstDefined<Array<string>>(["],
    ["const token = value.split(':', 1)[0];", "value.split(':'"],
    ["token: z.string().min(1),", "z.string().min(1)"],
    ["const secret = randomBytes(32).toString('hex');", "randomBytes(32).toString('hex')"],
  ])("redacts the value superseded by the ruling9 policy %#", (text, value) => {
    const expected = text!.replace(value!, SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(text!)).toBe(expected);
    expect(redactSecretAnswer(text!, "Which one should I use?")).toBe(expected);
  });

  test.each(["token: tok,", "token = text;"])(
    "keeps the restored unshaped second tier: %s",
    (text) => {
      expect(redactSecretPrompt(text)).toBe(text);
      expect(redactSecretAnswer(text)).toBe(text);
    },
  );
});
