import { describe, expect, test } from "vitest";
import {
  redactSecretAnswer,
  redactSecretKey,
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
  ])("redacts recognizable credential spans in a neutral answer (%#)", (secret) => {
    const answer = `Before ${secret}+synthetic-tail after`;
    const result = redactSecretAnswer(answer);
    expect(result).toContain(SECRET_ANSWER_NOTICE);
    expect(result).not.toContain(secret);
    expect(result).toBe(redactSecretPrompt(answer));
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
  ])("redacts quoted, encoded and suffix-bearing assignments in neutral answers (%#)", (answer) => {
    const result = redactSecretAnswer(answer);
    expect(result).toContain(SECRET_ANSWER_NOTICE);
    expect(result).not.toBe(answer);
    expect(result).toBe(redactSecretPrompt(answer));
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
    expect(redactSecretAnswer(encoded)).toBe(
      encoded.replace("SYNTHETIC1234567890", SECRET_ANSWER_NOTICE),
    );
  });

  test.each([
    "Should token validation be enabled?",
    "Which token budget?",
    "What is the API key format?",
    "I fixed token validation.",
    "Please review password handling.",
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
  "Done. Tests pass.",
];
const ordinaryPrompts = [
  "The secret-scan: required check failed on this PR, please look.",
  "Tim kept these holds, credentials: anything that uses a key.",
  "Set GCS_AGENT_FILES_HMAC_SECRET_KEY: placeholder in the example file.",
  "Fix this yaml:\n  secretName: my-app-config\n  image: nginx",
  "Why does this fail? const client = new S3({ accessKeyId: process.env.KEY_ID })",
  "authorization: Bearer token goes in the header, see the docs.",
  "log line without anything sensitive in it\n".repeat(1_800),
  "log line without anything sensitive in it\n".repeat(1_400),
  "See %2525252520 please",
  "api_key=$API_KEY",
  "api_key=${API_KEY}",
  "api_key=<your-api-key>",
  "The invalidated first pass: don't re-run anything to work out what it opened.",
  "Head is 41c4e4c0bd7709490212ac97f0beda98ae2812ad, base 48e0c6e50680e0a049de5cafbd8d693826e78c34.",
  "sha256: a734139041ee4b89220c99a6568a6704aa5464c04b02559ad2164e1f9a5338ac",
  "agent id bc299fea-5481-48e4-bb5f-31fc299789a1 token count 1500",
  "Issue page 40bb71dd7bc7818a8f89fb2be1ccaac2 key finding",
  "Set max_tokens: 4096 and token_count: 1500 in the config.",
  "apiKey: process.env.ANTHROPIC_API_KEY",
  "password=$DB_PASSWORD and token=${GITHUB_TOKEN}",
  "secret: {{ secrets.FOO }} and password: <your password>",
  'api_key = os.environ["ANTHROPIC_API_KEY"]',
  "const token = await getToken(); const key = cache.get(id);",
  "key: /Users/tim/.ssh/id_ed25519 and cert: ./tls/server.pem",
  "Fingerprints: Anthropic 482b782fc066; GCS access d7bcaf4de8e3, secret 4dee46de6542.",
  "token: getAuthenticationTokenFromSessionStorageManagerFactory",
  "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAA".repeat(40),
  "integrity sha512-" + "Zm9vYmFyYmF6".repeat(7) + "==",
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
    expect(redactSecretAnswer(text!, context)).toBe(
      context === undefined ? redactSecretPrompt(text!) : SECRET_ANSWER_NOTICE,
    );
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
  test("removes encoded literal suffixes and preserves ordinary trailing prose", () => {
    const secret = "sk-ant-" + "a".repeat(40) + "%20SYNTHETIC1234567890";
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
  test("uses credential value requests for single-token chat replies without surrounding whitespace", () => {
    expect(redactSecretPrompt("hunter2", "Earlier result. Please enter your password:")).toBe(
      SECRET_ANSWER_NOTICE,
    );
    expect(redactSecretPrompt("hunter2", "Enter your password. Done now.")).toBe(
      SECRET_ANSWER_NOTICE,
    );
    expect(redactSecretPrompt("hunter2\n", "Password")).toBe("hunter2\n");
    expect(redactSecretPrompt("hunter2 more", "Password")).toBe("hunter2 more");
    expect(redactSecretPrompt("hunter2", "What's your API key?")).toBe(SECRET_ANSWER_NOTICE);
    // Latest K keeps conceptual chat discussion; the structured B noun policy
    // remains intentionally broader than the chat request policy.
    expect(redactSecretPrompt("hunter2", "What is a password?")).toBe("hunter2");
  });
  test("detects an incomplete PEM body after an ordinary label", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDX09OTFlfTk9UX1JFQUxfQ1JFREVOVElBTA==";
    expect(redactSecretPrompt("Private key: " + key)).toBe("Private key: " + SECRET_ANSWER_NOTICE);
  });
});

const syntheticMixed = "aB3dE7gH".repeat(5);
const syntheticHmac = "q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8";
const syntheticUrlPassword = "Zx9Qw8Er7Ty6";
const expandedSecrets = [
  ["postgres URL", "postgres://admin:s3cr3tPass99@db.internal:5432/app", "s3cr3tPass99"],
  ["mysql URL", "mysql://root:Tr0ub4dor3x@10.0.0.5/app", "Tr0ub4dor3x"],
  ["redis URL", "redis://:p4ssw0rdLong@cache:6379", "p4ssw0rdLong"],
  [
    "mongo URL",
    "mongodb+srv://svc:" + syntheticUrlPassword + "@cluster0.mongodb.net/db",
    syntheticUrlPassword,
  ],
  [
    "https URL",
    "https://bob:" + syntheticUrlPassword + "@internal.example.com/path",
    syntheticUrlPassword,
  ],
  [
    "database env",
    "DATABASE_URL=postgres://u:" + syntheticUrlPassword + "@h/db",
    syntheticUrlPassword,
  ],
  ["AWS ID", "key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
  ["Slack", "xoxb-1234567890-0987654321-" + syntheticMixed, syntheticMixed],
  ["Stripe live", "sk_live_" + syntheticMixed, syntheticMixed],
  ["Stripe test", "sk_test_" + syntheticMixed, syntheticMixed],
  ["Stripe restricted", "rk_live_" + syntheticMixed, syntheticMixed],
  ["npm", "npm_" + syntheticMixed, syntheticMixed],
  ["GitHub PAT", "github_pat_" + syntheticMixed + "_" + syntheticMixed, syntheticMixed],
  ["GitHub OAuth", "gho_" + syntheticMixed, syntheticMixed],
  ["OpenAI project", "sk-proj-" + syntheticMixed + syntheticMixed, syntheticMixed],
  ["Google", "AIzaSyA" + syntheticMixed.slice(0, 32), syntheticMixed.slice(0, 32)],
  ["SendGrid", "SG." + syntheticMixed.slice(0, 22) + "." + syntheticMixed, syntheticMixed],
  ["Resend", "re_" + syntheticMixed, syntheticMixed],
  ["Sentry", "sntrys_" + syntheticMixed + syntheticMixed, syntheticMixed],
  ["API header", "x-api-key: " + syntheticMixed, syntheticMixed],
  ["Cookie", "Cookie: session=" + syntheticMixed, syntheticMixed],
  ["Set-Cookie", "Set-Cookie: session=" + syntheticMixed + "; Path=/; HttpOnly", syntheticMixed],
  [
    "curl user",
    "curl -u admin:" + syntheticUrlPassword + " https://x.example",
    syntheticUrlPassword,
  ],
  ["password flag", "mysql --password " + syntheticUrlPassword + " -h db", syntheticUrlPassword],
  ["token flag", "gh --token=" + syntheticMixed, syntheticMixed],
  ["PGPASSWORD", "PGPASSWORD=" + syntheticUrlPassword + " psql -h db", syntheticUrlPassword],
  ["npmrc", "//registry.npmjs.org/:_authToken=" + syntheticMixed, syntheticMixed],
  [
    "natural password",
    "the password is " + syntheticUrlPassword + " for that box",
    syntheticUrlPassword,
  ],
  ["natural key", "my api key is " + syntheticMixed, syntheticMixed],
  ["YAML", "client_secret: " + syntheticMixed, syntheticMixed],
  ["TOML", 'api_key = "' + syntheticMixed + '"', syntheticMixed],
  ["TS", 'const apiKey = "' + syntheticMixed + '";', syntheticMixed],
  ["labelled hex", "secret key: " + "ab12".repeat(16), "ab12".repeat(16)],
  ["unlabelled HMAC", syntheticHmac, syntheticHmac],
  ["two values", `password=${syntheticMixed} token=${syntheticMixed}x`, syntheticMixed],
  [
    "multiline env",
    `A_KEY=${syntheticMixed}\nB_SECRET=${syntheticMixed}y\nC=plain`,
    syntheticMixed,
  ],
];

describe("expanded synthetic secret matrix", () => {
  test.each(expandedSecrets)("D2: %s", (_name, text, value) => {
    const result = redactSecretPrompt(text!);
    expect(result).not.toContain(value);
    expect(result).toContain(SECRET_ANSWER_NOTICE);
  });
  test.each([
    "open http://localhost:3000/a?b=1",
    "git@github.com:org/repo.git",
    "https://bob@internal.example.com/path",
    "postgres://user:${PASSWORD}@host/db",
    "postgres://$USER:$PASS@host/db",
    "postgres://user:<password>@host/db",
    "postgres://user:password@localhost:5432/app",
    "https://example.com:8080/a@b",
    "meet at 12:30, email bob@example.com",
    "ask @reviewer about https://github.com/tzheng11/paseo/pull/56",
    "npm i @studio/agentic@1.2.3 from https://registry.npmjs.org/",
    "pass --password and it prompts",
    'mysql --password "$DB_PASS"',
    "The token is expired and the key is missing.",
    "the password is required for that box",
    "my api key is not working, it says unauthorized",
    "Cookie: consent banner keeps showing",
    "x-api-key: required",
    "/Users/tim/Development/importantWorkspace2026/anotherFile12345.ts",
  ])("B2: preserves ordinary URL, flag and prose %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });
  test("redacts only URL passwords and preserves authority and path bytes", () => {
    const text = `before postgres://admin:${syntheticUrlPassword}@db:5432/app after`;
    expect(redactSecretPrompt(text)).toBe(
      `before postgres://admin:${SECRET_ANSWER_NOTICE}@db:5432/app after`,
    );
  });
  test("maps encoded URL password offsets without changing URL syntax", () => {
    const text = `🧪 postgres%3A%2F%2Fuser%3A${syntheticUrlPassword}%40host/db ✅`;
    expect(redactSecretPrompt(text)).toBe(
      `🧪 postgres%3A%2F%2Fuser%3A${SECRET_ANSWER_NOTICE}%40host/db ✅`,
    );
  });
  test.each(["%2F", "%3F", "%23", "%20", "%27", "%22", "%3C", "%3E"])(
    "keeps encoded password delimiters inside URL userinfo (%s)",
    (separator) => {
      const value = `Ab3Cd4Ef5${separator}Gh6Ij7Kl8`;
      const text = `before postgres://admin:${value}@db.internal/app after`;
      expect(redactSecretPrompt(text)).toBe(
        `before postgres://admin:${SECRET_ANSWER_NOTICE}@db.internal/app after`,
      );
      expect(redactSecretAnswer(text)).toBe(
        `before postgres://admin:${SECRET_ANSWER_NOTICE}@db.internal/app after`,
      );
    },
  );
  test("supports single-character and long RFC URI schemes", () => {
    for (const scheme of ["a", "custom".repeat(20)]) {
      const text = `${scheme}://u:Ab3Cd4Ef5@host/db`;
      expect(redactSecretPrompt(text)).toBe(`${scheme}://u:${SECRET_ANSWER_NOTICE}@host/db`);
    }
  });
  test.each([
    ["password=", "abc123%22xyz789"],
    ["--password=", "abc123%22xyz789"],
    ["the password is ", "abc123%22xyz789"],
    ["--token=", "Ab3Cd4Ef5%20Gh6Ij7Kl8"],
    ["Cookie: session=", "abc123%3Bxyz789"],
    ["Set-Cookie: session=", "abc123%22xyz789"],
    ["Cookie: session=", "abc123%0Axyz789"],
    ["Cookie: session=", "abc123%09xyz789"],
  ])("keeps encoded delimiters inside a labelled value (%s)", (label, value) => {
    expect(redactSecretPrompt(`${label}${value} after`)).toBe(
      `${label}${SECRET_ANSWER_NOTICE} after`,
    );
  });
});

describe("manager battery 6 calibration", () => {
  const symbolToken = "Zq8!rT2$wX5&nB7k";

  test.each(["token", "secret", "credential", "apiKey", "pass"])(
    "redacts complete mixed-symbol values assigned to %s",
    (key) => {
      for (const value of [symbolToken, "Zq8.rT2$wX5&nB7k"]) {
        for (const quote of ["", '"', "'"]) {
          for (const separator of [": ", " = "]) {
            const text = key + separator + quote + value + quote + " after";
            expect(redactSecretPrompt(text)).toBe(text.replace(value, SECRET_ANSWER_NOTICE));
            expect(redactSecretAnswer(text)).toBe(text.replace(value, SECRET_ANSWER_NOTICE));
          }
        }
      }
    },
  );

  test.each([
    "pass: getApiKey1234(config)",
    "token = getApiKey1234(config)",
    "secret = config.apiKey1234",
    "const tokenCount: number = countTokens(text)",
    "apiKeyName: openai-prod-key-2",
    "password_policy: min12chars",
    "SECRET_MANAGER_PROJECT=impower-production",
    "passwordHash: Argon2Hasher",
    "credentialsPath = ~/.config/gcloud/adc2.json",
    "open src/features/s3Upload/Base64Encoder2.ts",
    "the class Utf8ToUtf16Converter is slow",
    "run brands/hyperbola/apps/web2/src/app/page.tsx",
    "use the md5Sum and sha1Digest helpers",
    "use aB3dE7gH9kL2mN5pQ8rT here",
  ])("keeps ordinary pass labels, code and accepted chat gaps %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text, "Anything else?")).toBe(text);
  });

  test.each(["wks_9a12e95ee4e4af87", "prj_44e33a8ea8d50705", "task_9A12E95EE4E4AF87"])(
    "keeps prefixed hex IDs in neutral answers and chat %#",
    (value) => {
      expect(redactSecretAnswer(value, "Which value?")).toBe(value);
      expect(redactSecretPrompt("use " + value + " here")).toBe("use " + value + " here");
      expect(redactSecretAnswer(value, "Enter your password")).toBe(SECRET_ANSWER_NOTICE);
    },
  );

  test.each(["sk_live_", "sk_test_", "rk_live_", "re_", "hf_", "npm_", "ghp_", "sntrys_"])(
    "known credential prefix %s wins over a hex suffix",
    (prefix) => {
      const value = prefix + "9a12e95ee4e4af87";
      expect(redactSecretAnswer(value, "Which value?")).toBe(SECRET_ANSWER_NOTICE);
      expect(redactSecretPrompt("use " + value + " here")).toBe(
        "use " + SECRET_ANSWER_NOTICE + " here",
      );
    },
  );

  test.each([
    "Could you give me the staging DB password?",
    "Type the keychain password",
    "Provide your Apple ID password",
    "What is the password for user deploy?",
    "Paste the API key for Resend",
    "Enter the 1Password master password",
    "Router admin password?",
    "What passcode should I use for the Mac?",
  ])("withholds new direct request wording %#", (question) => {
    expect(redactSecretAnswer(symbolToken, question)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each([
    ["Should I rotate the database password now?", "yes, rotate it"],
    ["Did the password reset email arrive?", "not yet"],
    ["Do you want me to enter the password?", "no, I will do it"],
    ["The IC needs a password-free route, so what next?", "yes go ahead"],
  ])("B: withholds free structured replies to password discussions: %s", (question, answer) => {
    expect(redactSecretAnswer(answer!, question)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(answer!, question)).toBe(answer);
  });
  test("keeps a discussion using the ambiguous bare word secret", () => {
    const answer = "Secret Manager";
    const question = "Which secret store should we use?";
    expect(redactSecretAnswer(answer, question)).toBe(answer);
    expect(redactSecretPrompt(answer, question)).toBe(answer);
  });
});

describe("neutral structured answer calibration", () => {
  test.each([syntheticHmac, "aB3dE7gH9kLmN2pQ5rT8", "abc123xyz4567890"])(
    "withholds mixed single-token answers %#",
    (text) => {
      expect(redactSecretAnswer(text, "Which one should I use?")).toBe(SECRET_ANSWER_NOTICE);
    },
  );
  test.each([
    "aB3dE7gH9kLm",
    "ab12".repeat(16),
    "41c4e4c0bd7709490212ac97f0beda98ae2812ad",
    "bc299fea-5481-48e4-bb5f-31fc299789a1",
    "https://example.test/aB3dE7gH9kLmN2pQ5rT8",
    "/Users/tim/project1234567890",
    "Use the existing session",
  ])("preserves ordinary neutral answers %#", (text) => {
    expect(redactSecretAnswer(text, "Which one should I use?")).toBe(text);
  });
  test("retains the accepted short and longer shapeless general-chat gaps", () => {
    expect(redactSecretPrompt("aB3dE7gH9kLm")).toBe("aB3dE7gH9kLm");
    expect(redactSecretPrompt("my password has several ordinary words")).toBe(
      "my password has several ordinary words",
    );
  });
  test("a leading slash does not exempt a base64 secret from chat entropy scanning", () => {
    expect(redactSecretPrompt("/" + syntheticHmac)).toBe(SECRET_ANSWER_NOTICE);
    const ordinary = "/Users/tim/source/anotherWorkspace2026/sourceFile12345.ts";
    expect(redactSecretPrompt(ordinary)).toBe(ordinary);
    expect(redactSecretAnswer(ordinary)).toBe(ordinary);
  });
});

describe("environment label calibration", () => {
  test.each([
    "A_KEY",
    "B_SECRET",
    "MY_SERVICE_KEY",
    "STRIPE_KEY",
    "RESEND_KEY",
    "OPENAI_KEY",
    "SENTRY_DSN",
    "DB_PASS",
    "DB_PWD",
    "WEBHOOK_SIGNING_SECRET",
    "SESSION_COOKIE",
    "AUTH",
    "BASIC_AUTH",
    "PRIVATE_KEY",
    "SSH_KEY",
    "ENCRYPTION_KEY",
    "JWT",
  ])("withholds shaped values under %s", (key) => {
    expect(redactSecretPrompt(`${key}=${syntheticMixed}`)).toBe(`${key}=${SECRET_ANSWER_NOTICE}`);
  });
  test.each([
    "CLIENT_ID",
    "PUBLIC_KEY",
    "SORT_KEY",
    "PRIMARY_KEY",
    "CACHE_KEY",
    "FOREIGN_KEY",
    "PARTITION_KEY",
  ])("preserves excluded labels while redacting their entropy value under %s", (key) => {
    expect(redactSecretPrompt(`${key}=${syntheticHmac}`)).toBe(`${key}=${SECRET_ANSWER_NOTICE}`);
    expect(redactSecretPrompt(`"${key}": "${syntheticHmac}"`)).toBe(
      `"${key}": "${SECRET_ANSWER_NOTICE}"`,
    );
    const encodedValue = syntheticHmac + "%20" + syntheticHmac;
    expect(redactSecretPrompt(`${key}=${encodedValue}`)).toBe(
      `${key}=${SECRET_ANSWER_NOTICE}%20${SECRET_ANSWER_NOTICE}`,
    );
  });
});

describe("structural routing keys", () => {
  test.each([
    "authenticationConfigurationVersion2",
    "projectAuthenticationConfigurationV2",
    "questionIdentifier1234567890WithDetails",
    "approve-action-12345",
  ])("preserves ordinary routing identifiers %#", (key) => {
    expect(redactSecretKey(key)).toBe(key);
  });
  test.each(["sk-ant-" + syntheticMixed, "ghp_" + syntheticMixed])(
    "withholds explicit credentials used as keys %#",
    (key) => {
      expect(redactSecretKey(key)).toBe(SECRET_ANSWER_NOTICE);
    },
  );
});

describe("reviewer punctuated credential regression matrix", () => {
  test.each([
    ['export DB_PASSWORD="ab&cd#1234!xyz"', "ab&cd#1234!xyz"],
    ['password: "x?7kL:9mQ2vR4tZ"', "x?7kL:9mQ2vR4tZ"],
    ["my password is ab#cd1234567", "ab#cd1234567"],
    ["api key: ab;cd1234efgh5678", "ab;cd1234efgh5678"],
    ['--password "ab(cd)1234efgh"', "ab(cd)1234efgh"],
    ["Cookie: session=ab#cd1234567", "ab#cd1234567"],
    ["password=ab#cd1234567xyz", "ab#cd1234567xyz"],
    ["the password is Tr0ub4dor&3xyz", "Tr0ub4dor&3xyz"],
    ["password=abcd1234#efgh5678", "abcd1234#efgh5678"],
  ])("withholds the complete punctuated value %#", (text, value) => {
    expect(redactSecretAnswer(text!, "Anything else?")).toBe(
      text!.replace(value!, SECRET_ANSWER_NOTICE),
    );
    const result = redactSecretPrompt(text!);
    expect(result).not.toContain(value);
    expect(result).toContain(SECRET_ANSWER_NOTICE);
  });
  test("keeps matching outer quotes and unlabelled surrounding punctuation", () => {
    const text = 'before DB_PASSWORD="ab&cd#1234!xyz"; after';
    expect(redactSecretPrompt(text)).toBe(`before DB_PASSWORD="${SECRET_ANSWER_NOTICE}"; after`);
  });
  test.each(["tiny", "hunter", "1234"])(
    "password labels accept arbitrary non-reference values %#",
    (value) => {
      expect(redactSecretPrompt(`password=${value}`)).toBe(`password=${SECRET_ANSWER_NOTICE}`);
    },
  );
  test("withholds every punctuation byte inside a quoted password value", () => {
    expect(redactSecretPrompt('password="punct!#&?;:()"')).toBe(
      `password="${SECRET_ANSWER_NOTICE}"`,
    );
  });
  test("C: withholds a single plain word under a credential label", () => {
    expect(redactSecretAnswer("pass: first")).toBe(`pass: ${SECRET_ANSWER_NOTICE}`);
    expect(redactSecretPrompt("pass: first")).toBe(`pass: ${SECRET_ANSWER_NOTICE}`);
  });
});

describe("reviewer credential question regression matrix", () => {
  test.each([
    "What is your password?",
    "What is the root password?",
    "What is the sudo password?",
    "What is the admin password?",
    "What is the database password?",
    "Enter the VPN password",
    "Enter your password to continue",
    "Please enter the password for mac-mini-1",
    "Password for mac-mini-1?",
    "What is the password for this server?",
    "Enter your GitHub password",
    "What is the SSH passphrase?",
    "Admin password",
    "Sudo password:",
    "Enter the VPN passcode",
    "PIN",
    "What is the admin PIN?",
    "Please provide the service secret token",
    "Enter the customer API key for this host",
    "Paste your SSH token for mac-mini-1",
    "Give me the PIN",
    "Type your passcode to continue",
  ])("protects an arbitrary answer to a direct value request %#", (context) => {
    expect(redactSecretAnswer("xK9#mP2$vL5q", context)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt("xK9#mP2$vL5q", context)).toBe(SECRET_ANSWER_NOTICE);
  });
  test.each([
    "Should we reset the admin password?",
    "Which password manager should we use?",
    "Password reset",
    "Admin password manager",
    "What is a password?",
    "Should PIN validation be enabled?",
    "Please review password handling.",
  ])("preserves discussion rather than requesting the value %#", (context) => {
    expect(redactSecretAnswer("yes", context)).toBe("yes");
    expect(redactSecretPrompt("yes", context)).toBe("yes");
  });
});

describe("reviewer ordinary identifier regression matrix", () => {
  test.each([
    "claude-sonnet-5-5",
    "release-2026-11-01",
    "iss-6389-secret-answers",
    "us-east-1-production",
    "postgres-16-alpine",
    "2026-11-01T21:40:48Z",
    "user2@example-company.com",
    "Button2Component.tsx",
    "agent-message2.test.ts",
    "config.region2.default",
    "v2026.11.01-beta.2",
    "2026-11-01T21:40:48+00:00",
    "2026-11-01T21:40:48.123-0600",
  ])("keeps ordinary neutral structured identifiers %#", (value) => {
    expect(redactSecretAnswer(value, "Which one should I use?")).toBe(value);
  });
  test.each([
    "Please fix packages/server/src/aws/S3Client/upload.ts",
    "see src/main/java/com/acme/auth/OAuth2LoginController.java now",
    "rename AgentPromptContentBlockV2Serializer please",
    "const privateKey: Uint8Array = load()",
    "secretName: tls-cert-2024",
    "secret_name: prod-db-credentials-2",
    "credentials_file: /Users/me/.config/gcloud/application_default_credentials.json",
    "GOOGLE_APPLICATION_CREDENTIALS=/etc/app/service_account_credentials.json",
    "const apiKey = getApiKey1234(config)",
    "secretary: John2Smith",
  ])("keeps wordlike code, paths and non-secret field names %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
  });
});

describe("additional explicit provider formats", () => {
  test.each([
    "https://hooks.slack.com/services/T00000000/B00000000/SYNTHETICsyntheticSYNTHETIC1",
    "glpat-SYNTHETIC1234567890ab",
    "hf_SYNTHETIC1234567890abcd",
  ])("withholds explicit credential formats %#", (value) => {
    expect(redactSecretAnswer(value)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(`before ${value} after`)).toBe(
      `before ${SECRET_ANSWER_NOTICE} after`,
    );
  });
});

describe("current credential tiers and J/L policy", () => {
  // Password-family values and shaped credential values stay protected;
  // rooted calls and member expressions remain valid references.
  test.each([
    ["credentials: OAuth2Credentials", "OAuth2Credentials"],
    ["pass: testSuite1234", "testSuite1234"],
  ])("password and shaped credential values remain protected %#", (text, value) => {
    const start = text!.lastIndexOf(value!);
    expect(redactSecretPrompt(text!)).toBe(
      text!.slice(0, start) + SECRET_ANSWER_NOTICE + text!.slice(start + value!.length),
    );
    expect(redactSecretAnswer(text!)).toBe(text!.replace(value!, SECRET_ANSWER_NOTICE));
  });

  test("J does not exempt a 32-character hex suffix because it has a workspace prefix", () => {
    const value = "wks_9a12e95ee4e4af879A12E95EE4E4AF87";
    expect(redactSecretAnswer(value, "Which value?")).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(`use ${value} here`)).toBe(`use ${SECRET_ANSWER_NOTICE} here`);
  });

  test.each(["Provide the secret", "What is the secret for this host?"])(
    "L recognizes an explicit secret request: %s",
    (question) => {
      expect(redactSecretAnswer("hunter2x", question)).toBe(SECRET_ANSWER_NOTICE);
      expect(redactSecretPrompt("hunter2x", question)).toBe(SECRET_ANSWER_NOTICE);
    },
  );
});

describe("encoded local image paths", () => {
  test.each([
    "Emit settled assistant image Markdown: ![Encoded destination image](/private/var/folders/d9/hy1jfhyj777cr2cb7wzsq8h00000gn/T/agent-tab-image-stability-N6asqz/My%20image%20%D0%9C%D0%BE%D0%B8.png)",
    "/Users/tim/Development/source/S3Client/My%20image%20%D0%9C%D0%BE%D0%B8.png",
    "assets/generated/agent-tab-image-stability-N6asqz/My%20image%20%D0%9C%D0%BE%D0%B8.png",
    "/Users/tim/source/My image Мои.png",
    "assets/generated/My image Мои.png",
    "/Users/tim/source/literal%20filename.png",
  ])("preserves ordinary encoded and spaced local paths in both policies %#", (text) => {
    expect(redactSecretPrompt(text)).toBe(text);
    expect(redactSecretAnswer(text)).toBe(text);
  });
  test("continues protecting leading-slash opaque base64 values", () => {
    expect(redactSecretPrompt("/" + syntheticHmac)).toBe(SECRET_ANSWER_NOTICE);
  });
  test("does not confuse the Manager's synthetic AWS secret with camel-case path segments", () => {
    const value = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const text = `export AWS_SECRET_ACCESS_KEY=${value}\nnext line stays`;
    expect(redactSecretPrompt(text)).toBe(
      `export AWS_SECRET_ACCESS_KEY=${SECRET_ANSWER_NOTICE}\nnext line stays`,
    );
    expect(redactSecretAnswer(text)).toBe(
      `export AWS_SECRET_ACCESS_KEY=${SECRET_ANSWER_NOTICE}\nnext line stays`,
    );
  });
});

describe("ruling9 changes to older K2 expectations", () => {
  test.each([
    [
      "In the schema, password: required for local accounts only.",
      `In the schema, password: ${SECRET_ANSWER_NOTICE} for local accounts only.`,
    ],
    [
      "password: required; api_key: optional; secret: none; token: expired",
      `password: ${SECRET_ANSWER_NOTICE}; api_key: optional; secret: none; token: expired`,
    ],
    ["pass: 3 tests", `pass: ${SECRET_ANSWER_NOTICE} tests`],
    ["pass = required", `pass = ${SECRET_ANSWER_NOTICE}`],
  ])(
    "uses closed password exceptions rather than the old broad placeholder list %#",
    (input, expected) => {
      expect(redactSecretPrompt(input!)).toBe(expected);
      expect(redactSecretAnswer(input!, "Which one should I use?")).toBe(expected);
    },
  );
  test.each(["token: tok,", "token: hunter2x", "credential: 'include'", "pin: 1234"])(
    "keeps short tier2 values and an unqualified pin label %#",
    (input) => {
      expect(redactSecretPrompt(input)).toBe(input);
      expect(redactSecretAnswer(input)).toBe(input);
    },
  );
  test("a URL path exemption does not exempt a high-entropy query value", () => {
    const input = "https://example.test/path/" + syntheticHmac + "?id=" + syntheticMixed;
    const expected = "https://example.test/path/" + syntheticHmac + "?id=" + SECRET_ANSWER_NOTICE;
    expect(redactSecretPrompt(input)).toBe(expected);
    expect(redactSecretAnswer(input)).toBe(expected);
  });
});
