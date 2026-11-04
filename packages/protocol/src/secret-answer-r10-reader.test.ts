import { describe, expect, test } from "vitest";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

// Every credential-like value in this matrix is synthetic. Expected strings also
// assert that the local reader preserves punctuation outside a matched value.
const synthetic = "Zx9qLm3vTq8Rb2";
const notice = SECRET_ANSWER_NOTICE;

const replaced = [
  ["internal closing punctuation", "password: xRW9Nc58LS)3MRxH", `password: ${notice}`],
  ["literal call with spaces", 'password=String("Synthetic value")', `password=${notice}`],
  ["trailing parenthesis", `token: ${synthetic})`, `token: ${notice})`],
  ["trailing bracket", `token: ${synthetic}]`, `token: ${notice}]`],
  ["trailing brace", `token: ${synthetic}}`, `token: ${notice}}`],
  ["trailing separators", `password: ${synthetic};,`, `password: ${notice};,`],
  ["internal semicolon", "api_key=Ab3d;Ef5gH7jK9m", `api_key=${notice}`],
  [
    "shell command terminator",
    "export PASSWORD=hunter2x;make deploy",
    `export PASSWORD=${notice};make deploy`,
  ],
  [
    "shell conjunction terminator",
    "PASSWORD=hunter2x&&make deploy",
    `PASSWORD=${notice}&&make deploy`,
  ],
  ["double equals", `password== ${synthetic}`, `password== ${notice}`],
  ["bare label literal comparison", 'password === "fluffy!"', `password === "${notice}"`],
  ["double colon", `api-key:: ${synthetic}`, `api-key:: ${notice}`],
  ["spaced equals", `password = = ${synthetic}`, `password = = ${notice}`],
  ["triple double quote", `password = """${synthetic}"""`, `password = """${notice}"""`],
  ["triple single quote", `password = '''${synthetic}'''`, `password = '''${notice}'''`],
  [
    "named setter argument",
    `setPassword(value: "${synthetic}")`,
    `setPassword(value: "${notice}")`,
  ],
  ["PIN code", "PIN code: 4821", `PIN code: ${notice}`],
  ["SIM PIN", "SIM PIN: 4821", `SIM PIN: ${notice}`],
  ["card PIN", "card PIN: 4821", `card PIN: ${notice}`],
  ["qualified pass", "admin pass: fluffy", `admin pass: ${notice}`],
  ["embedded qualified pass", "DB_PASS=fluffy", `DB_PASS=${notice}`],
  ["bare pass with shaped value", `pass: ${synthetic}`, `pass: ${notice}`],
  ["bullet pass field", `- pass: ${synthetic}`, `- pass: ${notice}`],
  ["JSON pass field", `{"pass":"${synthetic}"}`, `{"pass":"${notice}"}`],
  ["environment-suffixed pass field", `PASS_PROD=${synthetic}`, `PASS_PROD=${notice}`],
  ["declared pass field", `const pass=${synthetic};`, `const pass=${notice};`],
  ["subscript pass field", `config["pass"]=${synthetic}`, `config["pass"]=${notice}`],
  ["member pass field", `config.pass=${synthetic}`, `config.pass=${notice}`],
  ["username adjacent pass field", `user=bob pass=${synthetic}`, `user=bob pass=${notice}`],
  ["pass spaced table field", `| Pass | ${synthetic} |`, `| Pass | ${notice} |`],
  [
    "other password labels retain their policy",
    "163 tests password: hunter2x",
    `163 tests password: ${notice}`,
  ],
  [
    "error state with shaped value",
    `wrong_password: "${synthetic}"`,
    `wrong_password: "${notice}"`,
  ],
  ["copula short mixed value", "the password is Summer2024!", `the password is ${notice}`],
  ["spaced table cell", `| password | ${synthetic} |`, `| password | ${notice} |`],
  [
    "stray quote before a setter",
    `' unrelated setPassword("${synthetic}")`,
    `' unrelated setPassword("${notice}")`,
  ],
  [
    "JSON value is local",
    `curl -d '{"password":"${synthetic}","user":"bob"}' https://example.test`,
    `curl -d '{"password":"${notice}","user":"bob"}' https://example.test`,
  ],
] as const;

const kept = [
  ["setter declaration", "setX(name: Type)"],
  [
    "method declaration",
    "async setHostPassword(serverId: string, password: string): Promise<void> {",
  ],
  ["parameter declaration", "function hashDaemonPassword(password: string): string {"],
  ["bare pass prose", "pass: 3 tests"],
  ["bare pass short value", "pass: hunter2x"],
  ["count report pass noun", "163 tests pass: 123456/123456+synthetic"],
  ["case report pass noun", "final head307 cases pass: 123456/123456+synthetic"],
  ["pass copula in report prose", "earlier full agentic pass was 123456/123456+synthetic"],
  ["nearby the is not a label qualifier", "no longer abort the pass: 123456/123456+synthetic"],
  ["bare PASS prose", '"PASS": "Pass"'],
  ["bare pass increment", "pass += 1"],
  ["nonadjacent pass qualifier", "admin says pass: 3 tests"],
  ["password error translation", 'incorrect_password: "Incorrect password"'],
  ["password error word", "wrong_password: incorrect"],
  ["suffixed password error label", 'password_invalid: "Invalid password"'],
  ["qualified password error label", 'missing_database_password: "Missing password"'],
  ["plain copula prose", "the password is stored in a vault"],
  ["copula file path", "the password is /tmp/local-password.txt"],
  ["shell substitution spaces", "PASSWORD=$(op read op://vault/db/password)"],
  ["shell security substitution", "DB_PASSWORD=$(security find-generic-password -s db -w)"],
  ["template default spaces", "password: ${DB_PASSWORD:-local dev}"],
  ["compact table gap", `x|password|${synthetic}|`],
  ["fully quoted table gap", `"| password | ${synthetic} |"`],
  ["regex alternation", "grep -E 'a|password|b|c'"],
  ["union type", "type Allowed = User | Password | undefined;"],
  ["comparison expression", 'password: typeof x === "function"'],
  ["typeof LHS comparison", 'typeof settings.password === "function"'],
] as const;

describe("consolidated reader rules", () => {
  test.each(["admin", "guest"])(
    "does not borrow a preceding username value as the pass qualifier: %s",
    (username) => {
      for (const redact of [redactSecretPrompt, redactSecretAnswer]) {
        expect(redact(`username=${username} pass=xK9#mP2$vL5q`)).toBe(
          `username=${username} pass=${notice}`,
        );
        expect(redact(`username=${username} pass=fluffy`)).toBe(`username=${username} pass=fluffy`);
        expect(redact("admin pass=fluffy")).toBe(`admin pass=${notice}`);
      }
    },
  );
  test.each([
    "password",
    "**Password**",
    "__PIN code__",
    "the __PIN code__",
    "<b>Password</b>",
    "password for synthetic-host",
    "the API key",
    "config['password']",
    "DB_PASSWORD_PROD",
  ])("retains credential copula prefixes after the cheap filter: %s", (prefix) => {
    for (const redact of [redactSecretPrompt, redactSecretAnswer]) {
      expect(redact(`${prefix} is ${synthetic}`)).toBe(`${prefix} is ${notice}`);
    }
  });
  test.each(["x", "the secret store", "tokenCount", "UNKNOWN_WORD_KEY"])(
    "rejects a noncredential copula prefix: %s",
    (prefix) => {
      const input = `${prefix} is ${synthetic}`;
      for (const redact of [redactSecretPrompt, redactSecretAnswer])
        expect(redact(input)).toBe(input);
    },
  );
  test.each(["%3B", "%2C", "%29", "%5D", "%7D"])(
    "preserves raw length through an encoded trailing delimiter %s",
    (suffix) => {
      const input = `token: EJ?WE96hO${suffix}`;
      for (const redact of [redactSecretPrompt, redactSecretAnswer]) {
        expect(redact(input)).toBe(`token: ${notice}`);
      }
    },
  );
  test.each([
    "mac",
    "wifi",
    "vpn",
    "ssh",
    "db",
    "root",
    "sudo",
    "laptop",
    "my",
    "the",
    "user",
    "admin",
    "account",
    "login",
    "email",
  ])("keeps the pass qualifier local: %s", (qualifier) => {
    for (const redact of [redactSecretPrompt, redactSecretAnswer]) {
      expect(redact(`${qualifier} pass: hunter2x`)).toBe(`${qualifier} pass: ${notice}`);
      expect(redact(`${qualifier} nearby prose pass: hunter2x`)).toBe(
        `${qualifier} nearby prose pass: hunter2x`,
      );
    }
  });
  for (const [name, input, expected] of replaced) {
    test.each([redactSecretPrompt, redactSecretAnswer])(`replaces ${name} (%#)`, (redact) => {
      expect(redact(input)).toBe(expected);
    });
  }
  for (const [name, input] of kept) {
    test.each([redactSecretPrompt, redactSecretAnswer])(`keeps ${name} (%#)`, (redact) => {
      expect(redact(input)).toBe(input);
    });
  }
});

// These outputs were checked against ac106c225 before indexing the local reader.
// Boundary expectations preserve its existing start-relative 4 KiB lookahead.
const cachedReaderCases = [
  [
    "quote classes preserve percent-encoded delimiters",
    'password: %22fluffy " inner%22 next=plain',
    `password: %22${notice}%22 next=plain`,
  ],
  [
    "quote classes preserve nested percent encoding",
    'password: %2522fluffy " inner%2522 next=plain',
    `password: %2522${notice}%2522 next=plain`,
  ],
  [
    "quote classes preserve unicode-escaped delimiters",
    String.raw`password: \u0022fluffy " inner\u0022 next=plain`,
    String.raw`password: \u0022${notice}\u0022 next=plain`,
  ],
  [
    "a percent-encoded newline does not terminate the quote",
    'password: "fluffy%0Ainner" next=plain',
    `password: "${notice}" next=plain`,
  ],
  [
    "a literal newline terminates the quote",
    'password: "fluffy\ninner" next=plain',
    `password: "${notice}\ninner" next=plain`,
  ],
  [
    "an encoded opening slash preserves the quoted field",
    'password: %5C"fluffy" next=plain',
    `password: %5C"${notice}" next=plain`,
  ],
  [
    "nested substitutions keep their complete reference",
    "password: ${DB_PASSWORD:-$(read vault/[db])} next=plain",
    "password: ${DB_PASSWORD:-$(read vault/[db])} next=plain",
  ],
  [
    "an escaped substitution newline preserves the original value extent",
    "password: $(op\\\n read vault) next=plain",
    `password: ${notice} next=plain`,
  ],
  [
    "an encoded angle close is not a literal placeholder terminator",
    "password: <hidden %3E allowed> next=plain",
    `password: ${notice} next=plain`,
  ],
  [
    "an encoded angle opener is not a literal placeholder opener",
    "password: %3Chidden allowed> next=plain",
    `password: ${notice} allowed> next=plain`,
  ],
  [
    "shared quote facts keep adjacent field policies separate",
    'password: %22fluffy " inner%22; password: "second"; pass: 3 tests',
    `password: %22${notice}%22; password: "${notice}"; pass: 3 tests`,
  ],
] as const;

for (const [api, redact] of [
  ["prompt", redactSecretPrompt],
  ["answer", redactSecretAnswer],
] as const) {
  describe(`cached local value reader (${api})`, () => {
    test.each(cachedReaderCases)("%s", (_name, input, expected) => {
      expect(redact(input)).toBe(expected);
    });

    test.each([0, 1, 2, 3, 5, 7])("preserves serialized quote escape depth %i", (depth) => {
      const quote = `${"\\".repeat(depth)}"`;
      const inner = `${"\\".repeat(2 * depth + 1)}"`;
      expect(redact(`password: ${quote}fluffy${inner}inner${quote} tail`)).toBe(
        `password: ${quote}${notice}${quote} tail`,
      );
    });

    for (const [opening, closing, width] of [
      ['"', '"', 1],
      ["“", "”", 1],
      ['"""', '"""', 3],
      ["%22", "%22", 1],
      [String.raw`\u0022`, String.raw`\u0022`, 1],
    ] as const) {
      test.each([-1, 0, 1])(
        `preserves ${opening} closing quote at the 4 KiB boundary offset %i`,
        (offset) => {
          const gap = " ".repeat(4_096 + offset - width - "fluffy".length);
          const input = `password: ${opening}fluffy${gap}${closing} tail`;
          const remaining = offset < 0 ? "" : gap;
          expect(redact(input)).toBe(`password: ${opening}${notice}${remaining}${closing} tail`);
        },
      );
    }

    test.each([-1, 0, 1])("preserves an angle close at the 4 KiB boundary offset %i", (offset) => {
      const padding = "x".repeat(4_088 + offset);
      const input = `password: <hidden ${padding}> tail`;
      expect(redact(input)).toBe(offset < 0 ? input : `password: ${notice} ${padding}> tail`);
    });

    test.each([-1, 0, 1])(
      "preserves a substitution close at the 4 KiB boundary offset %i",
      (offset) => {
        const padding = "x".repeat(4_091 + offset);
        const input = `password: $(op ${padding}) tail`;
        expect(redact(input)).toBe(offset < 0 ? input : `password: ${notice} ${padding}) tail`);
      },
    );

    test.each([-1, 0, 1])(
      "preserves a shell word run at the 4 KiB boundary offset %i",
      (offset) => {
        const command = "a".repeat(4_096 + offset);
        const input = `PASSWORD=fluffy;${command} rest`;
        expect(redact(input)).toBe(
          offset <= 0 ? `PASSWORD=${notice};${command} rest` : `PASSWORD=${notice} rest`,
        );
      },
    );

    test.each([4_095, 4_096, 4_097])("preserves %i literal spaces before a value", (length) => {
      const spaces = " ".repeat(length);
      expect(redact(`password:${spaces}fluffy; pass: 3 tests`)).toBe(
        `password:${spaces}${notice}; pass: 3 tests`,
      );
    });
  });
}
