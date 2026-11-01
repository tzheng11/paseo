/** The entire answer is withheld so a matched prefix cannot leave a secret's suffix behind. */
export const SECRET_ANSWER_NOTICE =
  "[redacted:secret] This answer was withheld because it may contain a secret. Use a secret store instead.";

const MAX_ANSWER_LENGTH = 65_536;
const MAX_NORMALIZATION_PASSES = 4;

// Ported from Studio's redact-segment-secrets.ts on origin/develop (8e33d51882ca).
// Answers use whole-field withholding rather than transcript substring replacement.
const SECRET_KEY_WORDS = String.raw`secret|hmac|passwd|password|credential|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?token|bearer[_-]?token|session[_-]?token`;
const LITERAL_PATTERNS: readonly RegExp[] = [
  /\bGOOG[0-9A-Z]{12,60}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,60}\b/,
  /\bya29\.[A-Za-z0-9._-]{20,}/,
  /\bsk-ant-[A-Za-z0-9._-]{20,}/,
  /(?<![A-Za-z0-9])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,512}|(?:[A-Za-z0-9]{1,16}-(?=[A-Za-z0-9_-]{40}))?[A-Za-z0-9]{20,512}[A-Za-z0-9_-]{0,512})/,
  /(?<![A-Za-z0-9])impr_(?:mcp|oat)_[A-Za-z0-9_-]{16,512}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bdtn_[A-Za-z0-9]{16,}\b/,
];
const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.(?:[A-Za-z0-9_-]{1,4096}|(?=\.[A-Za-z0-9_-]{1}))(?:\.[A-Za-z0-9_-]{0,4096}){0,3}/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// The same authorization schemes can be pasted without their HTTP header name.
const AUTHORIZATION_SCHEME_PATTERN = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9+/=_.%-]{16,4096}/i;
const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_WORDS, "i");
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]{1,64})["']?\s{0,64}[:=]\s{0,64}["']?/g;
const ASSIGNED_VALUE_PATTERN = /^[^\s'";,}\]\\]{1,65536}/;
const TOKEN_KEY_PATTERN =
  /(?:(?:access|refresh|mcp)[_-]?token|(?<![A-Za-z0-9])id[_-]?token|(?<![A-Za-z0-9_.-])token|protection[_-]bypass)$/i;
const ENV_TOKEN_KEY_PATTERN = /(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{0,60}_TOKEN$/;
const TOKEN_VALUE_PATTERN = /^[A-Za-z0-9+/=_%-][A-Za-z0-9+/=_.%-]{14,65534}[A-Za-z0-9+/=_%-]$/;
const WORDS_ONLY_VALUE =
  /^(?:[a-z]{1,24}(?:[_-][a-z]{1,24}){1,16}|[A-Z]{1,24}(?:[_-][A-Z]{1,24}){1,16}|(?:[A-Z][a-z]{0,24}[_-]?){2,8}|[a-z]{1,24}(?:[A-Z][a-z]{1,24}){1,16})$/;
const NON_SECRET_VALUE = /^(?:true|false|null|undefined|[\d.]+)$/i;
const SIGNED_URL_SIGNER_PARAM = /^x-(?:goog|amz)-credential$/i;
const DIAGNOSTIC_SECRET_KEY = /^(?:authorization|daemonPublicKeyB64|relayKey)$/i;
const SECRET_CONTEXT_PATTERN =
  /\b(?:passwords?|passwds?|passphrases?|secrets?|credentials?|hmac|(?:private|api|access|auth|bearer|session)[ _-]?keys?|(?:api|auth|bearer|session|access|refresh|id)[ _-]?tokens?|keys?|tokens?)\b/gi;
const CREDENTIAL_REQUEST_PATTERN =
  /\b(?:enter|provide|paste|supply|share|send|type|input|give|what|which|need)\b/i;
const CREDENTIAL_DISCUSSION_PATTERN =
  /^\s*(?:budget|limit|count|usage|validation|validator|enabled|name|reference|path|format|pattern|type|length|rotation|management|storage|handling|policy|support)\b/i;
const ENCODED_CHARACTER_PATTERN =
  /%([\da-f]{2})|\\u([\da-f]{4})|\\x([\da-f]{2})|&#x([\da-f]{1,6});?|&#(\d{1,7});?|&(colon|equals|quot|apos);|\\([\\"'/nrt])/gi;

function isTokenValue(value: string): boolean {
  return !WORDS_ONLY_VALUE.test(value) && !NON_SECRET_VALUE.test(value);
}

function isDottedCode(value: string): boolean {
  return (
    /[.%]/.test(value) &&
    value.split(/\.|%[0-9A-Fa-f]{2}/).every((part) => part.length < 16 || !isTokenValue(part))
  );
}

interface AssignmentCandidate {
  key: string;
  value: string;
  query: boolean;
}

function isSecretAssignment({ key, value, query }: AssignmentCandidate): boolean {
  if (value.startsWith("[redacted") || value.startsWith("${") || NON_SECRET_VALUE.test(value)) {
    return false;
  }
  const secretKey = SECRET_KEY_PATTERN.test(key);
  const tokenKey = TOKEN_KEY_PATTERN.test(key) || ENV_TOKEN_KEY_PATTERN.test(key);
  if (query) {
    const secretQueryKey = secretKey || tokenKey;
    return (
      secretQueryKey &&
      !SIGNED_URL_SIGNER_PARAM.test(key) &&
      value.length >= 8 &&
      isTokenValue(value)
    );
  }
  if (DIAGNOSTIC_SECRET_KEY.test(key)) return value.length > 0;
  if (secretKey) return value.length >= 8;
  return tokenKey && TOKEN_VALUE_PATTERN.test(value) && isTokenValue(value) && !isDottedCode(value);
}

function hasSecretAssignment(text: string): boolean {
  let scanned = 0;
  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    const key = match[1]!;
    const start = match.index + match[0].length;
    const raw = ASSIGNED_VALUE_PATTERN.exec(text.slice(start))?.[0] ?? "";
    scanned += raw.length;
    if (scanned > MAX_ANSWER_LENGTH * 8 + 2_048) return true;
    const before = text[match.index - 1];
    const query = before === "?" || before === "&";
    const value = query ? raw.split(/[&#]/, 1)[0]! : raw;
    if (isSecretAssignment({ key, value, query })) return true;
  }
  return false;
}

function decodeView(value: string): string {
  return value.replace(
    ENCODED_CHARACTER_PATTERN,
    (
      match,
      percent: string | undefined,
      unicode: string | undefined,
      hexadecimal: string | undefined,
      entityHex: string | undefined,
      entityDecimal: string | undefined,
      entityName: string | undefined,
      escaped: string | undefined,
    ) => {
      const hex = percent ?? unicode ?? hexadecimal ?? entityHex;
      if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
      if (entityDecimal !== undefined) {
        return String.fromCharCode(Number.parseInt(entityDecimal, 10));
      }
      switch (entityName?.toLowerCase()) {
        case "colon":
          return ":";
        case "equals":
          return "=";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      switch (escaped) {
        case "n":
        case "r":
        case "t":
          return " ";
        case undefined:
          return match;
        default:
          return escaped;
      }
    },
  );
}

function detectionView(value: string): string | null {
  let view = value;
  for (let pass = 0; pass < MAX_NORMALIZATION_PASSES; pass += 1) {
    const decoded = decodeView(view);
    if (decoded === view) return view;
    view = decoded;
  }
  // A deliberately over-encoded answer must not turn the bounded scan into a bypass.
  return decodeView(view) === view ? view : null;
}

function requestsCredential(context: string): boolean {
  return context.split(/[\r\n]/).some((rawLine) => {
    const line = rawLine.replace(/[*_~`#[\]]/g, "");
    const request = CREDENTIAL_REQUEST_PATTERN.exec(line);
    for (const match of line.matchAll(SECRET_CONTEXT_PATTERN)) {
      const before = line.slice(0, match.index).trim();
      const after = line.slice(match.index + match[0].length).trim();
      if (CREDENTIAL_DISCUSSION_PATTERN.test(after)) continue;
      const fieldEnding =
        /^(?:value\s*)?(?:please\s*)?(?:(?:required|optional|needed)\s*)?(?:[?:.]|\((?:required|optional)\))?$/i.test(
          after,
        );
      const fieldPrefix =
        /^(?:(?:your|the|a|an|mac|macos|login|account|service|user|current|new)\s*)*$/i.test(
          before,
        );
      const fieldQualifier = before === "" && /^(?:for|to|of)\b[^.!\n]{0,64}[?:]$/i.test(after);
      const title = (fieldPrefix && fieldEnding) || fieldQualifier;
      const askedBefore = request !== null && request.index < match.index;
      if (title || askedBefore) return true;
    }
    return false;
  });
}

/** Only detection sees decoded text; ordinary answers retain their exact original bytes. */
export function redactSecretAnswer(text: string, context?: string): string {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return text;
  if (text.length > MAX_ANSWER_LENGTH) return SECRET_ANSWER_NOTICE;
  const view = detectionView(text);
  if (view === null) return SECRET_ANSWER_NOTICE;
  if (context !== undefined) {
    if (context.length > MAX_ANSWER_LENGTH) return SECRET_ANSWER_NOTICE;
    const contextView = detectionView(context);
    if (contextView === null || requestsCredential(contextView)) {
      return SECRET_ANSWER_NOTICE;
    }
  }
  const recognizedSecret =
    PRIVATE_KEY_PATTERN.test(view) ||
    AUTHORIZATION_SCHEME_PATTERN.test(view) ||
    JWT_PATTERN.test(view) ||
    hasSecretAssignment(view) ||
    LITERAL_PATTERNS.some((pattern) => pattern.test(view));
  return recognizedSecret ? SECRET_ANSWER_NOTICE : text;
}
