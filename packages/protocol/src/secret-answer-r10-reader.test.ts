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
