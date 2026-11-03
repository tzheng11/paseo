export interface SecretPerformanceFixture {
  id: string;
  prefix: string;
  unit: string;
  suffix?: string;
  group: "manager" | "vocabulary" | "stress";
  label?: string;
  tier?: "password" | "credential";
  production?: string;
  valueName?: string;
}

interface PerformanceLabel {
  label: string;
  tier: "password" | "credential";
  production: string;
}

// Finite representatives of every lexical alternative in credentialTier.
// Prefixes and digit strings are unbounded; their normalization productions are
// represented separately rather than treating this as every possible spelling.
const passwordWords = ["password", "passwd", "passphrase", "passcode", "pwd"] as const;
const environments = [
  "prod",
  "production",
  "dev",
  "development",
  "staging",
  "test",
  "local",
  "base",
] as const;
const pinQualifiers = [
  "login",
  "security",
  "admin",
  "user",
  "account",
  "device",
  "auth",
  "authentication",
  "access",
  "customer",
  "bank",
  "card",
  "atm",
  "sim",
] as const;
const passQualifiers = [
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
] as const;
const errors = ["incorrect", "invalid", "wrong", "bad", "missing"] as const;
const keyQualifiers = [
  "api",
  "secret",
  "access",
  "private",
  "hmac",
  "signing",
  "encryption",
  "ssh",
  "aws",
  "google",
  "gcp",
  "azure",
  "github",
  "gitlab",
  "stripe",
  "openai",
  "anthropic",
  "resend",
  "sendgrid",
  "sentry",
  "slack",
  "npm",
  "docker",
  "cloudflare",
  "supabase",
  "firebase",
  "database",
  "db",
  "oauth",
  "auth",
  "jwt",
  "session",
  "webhook",
  "relay",
] as const;

function performanceLabels(): PerformanceLabel[] {
  const labels: PerformanceLabel[] = [];
  const add = (label: string, tier: PerformanceLabel["tier"], production: string): void => {
    labels.push({ label, tier, production });
  };
  for (const word of passwordWords) add(word, "password", "password suffix");
  for (const env of environments) {
    add(`DB_PASSWORD_${env.toUpperCase()}`, "password", "environment suffix");
  }
  add("dbpassword", "password", "embedded password suffix");
  add("password17", "password", "numeric postfix");
  for (const qualifier of pinQualifiers) {
    for (const suffix of ["PIN", "PIN code", "PIN number"]) {
      add(`${qualifier} ${suffix}`, "password", "qualified PIN");
    }
  }
  for (const label of ["PIN code", "PIN number"]) add(label, "password", "PIN code/number");
  for (const qualifier of passQualifiers) {
    add(`${qualifier} pass`, "password", "qualified pass");
  }
  for (const error of errors) {
    for (const word of passwordWords) {
      add(`${error}_${word}`, "credential", "error-state password downgrade");
    }
  }
  for (const word of [
    "pass",
    "token",
    "tokens",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "jwt",
    "auth",
    "dsn",
  ])
    add(word, "credential", "credential suffix");
  for (const qualifier of keyQualifiers) {
    add(`${qualifier} key`, "credential", "issuer/credential key");
  }
  for (const qualifier of ["service", "storage"]) {
    add(`${qualifier} account key`, "credential", "account key");
  }
  for (const word of [
    "authToken",
    "accessToken",
    "refreshToken",
    "clientSecret",
    "sessionCookie",
    "JWT_AUTH",
    "DB_DSN",
    "token12",
  ])
    add(word, "credential", "compound and numeric suffix");
  for (const label of ["api_key", "api-key", "apiKey", "APIKEY", "ACCESS_TOKEN", "access-token"]) {
    add(label, "credential", "normalization");
  }
  return labels;
}

export const SECRET_PERFORMANCE_LABELS = performanceLabels();
export const SECRET_PERFORMANCE_OPERATORS = [
  ":",
  "=",
  ":=",
  "::",
  "=>",
  "->",
  "?=",
  "+=",
  "||=",
  "??=",
  "==",
  "===",
  "!=",
  "!==",
] as const;
export const SECRET_PERFORMANCE_VALUES = [
  ["empty", ""],
  ["one", "a"],
  ["twelve", "aB3dE5gH7jK9"],
  ["sixty-four", "aB3dE5gH7jK9mN1p".repeat(4)],
] as const;

const managerForms = [
  ["password-arrow", "", "password => "],
  ["query-password", "https://h/p?", "&password=a"],
  ["password-or-assignment", "", "password ||= "],
  ["password-short", "", "password: x "],
  ["token-arrow", "", "token => "],
  ["api-key-short", "", "api_key: a "],
  ["secret-empty", "", "secret = "],
] as const;

export const SECRET_MANAGER_PERFORMANCE_FORMS: readonly SecretPerformanceFixture[] =
  managerForms.map(([id, prefix, unit]) => ({
    id: `manager/${id}`,
    prefix,
    unit,
    group: "manager",
  }));

/** The earlier hostile forms remain coverage even when the timing gate moves out of CI. */
export const SECRET_PERFORMANCE_STRESS_FORMS: readonly SecretPerformanceFixture[] = [
  ["failed terminal compound", "", "password => ", 'String("synthetic")'],
  ["conditional chain", "", "password => a ? b : "],
  ["unclosed setter chain", "", "setPassword(a, setPassword(a, "],
  ["compound call chain", "", "password => foo() || "],
  ["compound member chain", "", "password => config.value || "],
  ["compound argument chain", "", "password => foo(bar) || "],
  ["compound group chain", "", "password => (a || b) || "],
  ["unclosed compound chain", "", "password => (a || "],
  ["compound prefix chain", "", "password => readonly value || "],
  ["P1 unquoted cookies", "Cookie: ", "a=b;"],
  ["P1 set-cookie", "Set-Cookie: ", "sid=abc1;"],
  ["P1 quoted cookies", "Cookie: ", 'a="b";'],
  ["P1 dense cookie fields", "cookie:1;", "a=b;c=d;"],
  ["P1 shaped cookies", "Cookie: ", "sid=abcdef123456;"],
  ["P2 data labels", "", "data:"],
  ["P2 data values", "", "data:x;"],
  ["P2 minified data objects", "", '{data:a,type:"x",id:1},'],
  ["P3 repeated provider prefixes", "", "sk-ant-"],
  ["P4 known-key lines", "", "sk-ant-aB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gHaB3dE7gH\n"],
  ["one-line prose", "", "ordinary prose containing no values, "],
  [
    "one curly-quoted password then prose",
    "password: “fluffy” ",
    "ordinary prose containing no values, ",
  ],
  ["repeated unclosed curly password", "", "password: “a "],
  ["repeated password open paren", "", "password: ( "],
  ["repeated password open brace", "", "password: { "],
  ["repeated token open paren", "", "token: ( "],
  ["repeated unmatched shell substitution", "", "password: $( a "],
  ["repeated unmatched template substitution", "", "password: ${ a "],
  ["repeated token substitution", "", "token: $( a "],
  ["password paren/comma at line end", "", "password: (a,\n"],
  ["token paren/comma at line end", "", "token: (a,\n"],
  ["opener followed by long body", "password: (", `${"a".repeat(32)} `],
  ["key chain with short continuation", "", "password: a.b.c( "],
  ["unfinished define literal", "", 'define("a",'],
  ["unrelated copula", "", "x is "],
  ["dense API key labels", "", "api key: "],
  ["dense setter labels", "", 'setPassword("'],
  ["dense spaced table cells", "", "| password | a |\n"],
  ["dense JSON labels", "", '{"password":"a"},'],
  ["dense token cookies", "Cookie: ", "token=abcdef123456;"],
  ["dense query tokens", "?token=", "a&token="],
  ["nested parentheses", "password: ", "("],
  ["dense password equals quote", "", "password='"],
].map(([id, prefix, unit, suffix]) => ({
  id: `stress/${id}`,
  prefix: prefix!,
  unit: unit!,
  suffix,
  group: "stress",
}));

function setterName(label: string): string {
  return label
    .split(/[ _-]+/)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function* secretPerformanceMatrix(): Generator<SecretPerformanceFixture> {
  yield* SECRET_MANAGER_PERFORMANCE_FORMS;
  for (const { label, tier, production } of SECRET_PERFORMANCE_LABELS) {
    for (const [valueName, value] of SECRET_PERFORMANCE_VALUES) {
      const base = { label, tier, production, valueName, group: "vocabulary" as const };
      for (const operator of SECRET_PERFORMANCE_OPERATORS) {
        if (/^[!=]={1,2}$/.test(operator) && tier !== "password") continue;
        yield {
          ...base,
          id: `symbol/${label}/${operator}/${valueName}`,
          prefix: "",
          unit: `${label} ${operator} ${value} `,
        };
      }
      yield {
        ...base,
        id: `quoted-key/${label}/${valueName}`,
        prefix: "",
        unit: `"${label}": ${value} `,
      };
      yield {
        ...base,
        id: `query/${label}/${valueName}`,
        prefix: "https://h/p?",
        unit: `&${label.replaceAll(" ", "_")}=${value}`,
      };
      for (const copula of ["is", "was", "are", "were"]) {
        for (const colon of ["", ":"]) {
          yield {
            ...base,
            id: `copula/${label}/${copula}${colon}/${valueName}`,
            prefix: "",
            unit: `the ${label} ${copula}${colon} ${value} `,
          };
        }
      }
      yield {
        ...base,
        id: `table/${label}/${valueName}`,
        prefix: "",
        unit: `| ${label} | ${value} | `,
      };
      const field = setterName(label);
      yield {
        ...base,
        id: `setter/${label}/${valueName}`,
        prefix: "",
        unit: `set${field}(${value}) `,
      };
      yield {
        ...base,
        id: `named-setter/${label}/${valueName}`,
        prefix: "",
        unit: `set${field}(value: ${value}) `,
      };
      yield {
        ...base,
        id: `define/${label}/${valueName}`,
        prefix: "",
        unit: `define('${label}', ${value}) `,
      };
      yield {
        ...base,
        id: `tuple/${label}/${valueName}`,
        prefix: "",
        unit: `['${label}', ${value}] `,
      };
      yield {
        ...base,
        id: `subscript/${label}/${valueName}`,
        prefix: "",
        unit: `config['${label}'] = ${value} `,
      };
    }
  }
}

export function secretPerformanceText(fixture: SecretPerformanceFixture, bytes: number): string {
  const { prefix, unit, suffix = "" } = fixture;
  if (!unit) throw new Error("Performance fixture must repeat a nonempty unit");
  const remaining = bytes - prefix.length - suffix.length;
  if (remaining < 0) throw new Error("Fixture exceeds the requested extent");
  if (suffix)
    return (
      prefix +
      unit.repeat(Math.floor(remaining / unit.length)) +
      " ".repeat(remaining % unit.length) +
      suffix
    );
  return (prefix + unit.repeat(Math.ceil(Math.max(0, remaining) / unit.length))).slice(0, bytes);
}
