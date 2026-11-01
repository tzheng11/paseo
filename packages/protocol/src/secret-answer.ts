/** The entire answer is withheld so a matched prefix cannot leave a secret's suffix behind. */
export const SECRET_ANSWER_NOTICE =
  "[redacted:secret] This answer was withheld because it may contain a secret. Use a secret store instead.";

const MAX_NORMALIZATION_PASSES = 16;

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
// The same authorization schemes can be pasted without their HTTP header name.
const AUTHORIZATION_SCHEME_PATTERN = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9+/=_.%-]{16,4096}/i;
const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_WORDS, "i");
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]{1,64})["']?\s{0,64}[:=]\s{0,64}["']?/g;
const TOKEN_KEY_PATTERN =
  /(?:(?:access|refresh|mcp)[_-]?token|(?<![A-Za-z0-9])id[_-]?token|(?<![A-Za-z0-9_.-])token|protection[_-]bypass)$/i;
const ENV_TOKEN_KEY_PATTERN = /(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{0,60}_TOKEN$/;
const WORDS_ONLY_VALUE =
  /^(?:[a-z]{1,24}(?:[_-][a-z]{1,24}){1,16}|[A-Z]{1,24}(?:[_-][A-Z]{1,24}){1,16}|(?:[A-Z][a-z]{0,24}[_-]?){2,8}|[a-z]{1,24}(?:[A-Z][a-z]{1,24}){1,16})$/;
const NON_SECRET_VALUE = /^(?:true|false|null|undefined|[\d.]+)$/i;
const SIGNED_URL_SIGNER_PARAM = /^x-(?:goog|amz)-credential$/i;
const DIAGNOSTIC_SECRET_KEY = /^(?:authorization|daemonPublicKeyB64|relayKey)$/i;
const QUALIFIED_CREDENTIAL = String.raw`(?:passwords?|passwds?|passphrases?|credentials?|(?:private|api|access|secret)[ _-]?keys?|(?:api|auth(?:entication)?|bearer|session|access|refresh|id)[ _-]?tokens?)`;
const FIELD_MODIFIERS = String.raw`(?:(?:your|the|mac|macos|login|account|service|user|current|new)\s+){0,5}`;
const FIELD_END = String.raw`(?:\s+(?:value|please|required|optional|needed))?(?:\s+\((?:required|optional)\))?\s*[:?.]?`;
const FIELD_TITLE_PATTERN = new RegExp(
  String.raw`^(?:${FIELD_MODIFIERS}${QUALIFIED_CREDENTIAL}${FIELD_END}|(?:keys?|tokens?|secret)\s*[:?]?)$`,
  "i",
);
const FIELD_QUALIFIER_PATTERN = new RegExp(
  String.raw`^${QUALIFIED_CREDENTIAL}\s+(?:for|of|to)\s+(?:(?:your|the)\s+)?(?:account|mac|macos|login|service|user)\s*[:?]$`,
  "i",
);
const IMPERATIVE_CREDENTIAL_PATTERN = new RegExp(
  String.raw`\b(?:enter|paste|provide|type|supply|give|send|share|input)\s+(?:me\s+)?(?:(?:your|the|a|an|both|mac|macos|login|account|service|user|current|new)\s+){0,5}${QUALIFIED_CREDENTIAL}${FIELD_END}$`,
  "i",
);
const INTERROGATIVE_CREDENTIAL_PATTERN = new RegExp(
  String.raw`\bwhat(?:'s|\s+is|\s+are)\s+(?:(?:your|the|current|new|mac|macos|login|account)\s+){1,5}${QUALIFIED_CREDENTIAL}\s*\??$`,
  "i",
);
const ENCODED_CHARACTER_PATTERN =
  /%((?:25)*[\da-f]{2})|\\u([\da-f]{4})|\\x([\da-f]{2})|&#x([\da-f]{1,6});?|&#(\d{1,7});?|&(colon|equals|quot|apos);|\\([\\"'/nrt])/gi;

function isTokenValue(value: string): boolean {
  if (NON_SECRET_VALUE.test(value)) return false;
  if (value.length > 1_024) return true;
  const plainWord = /^(?:[a-z]{1,24}|[A-Z]{1,24}|[A-Z][a-z]{0,23})$/.test(value);
  return !plainWord && !WORDS_ONLY_VALUE.test(value);
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
  const reference =
    /^(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|<[^<>\r\n]{1,256}>)$/.test(
      value,
    );
  if (
    value.startsWith("[redacted") ||
    value.startsWith("${") ||
    reference ||
    NON_SECRET_VALUE.test(value)
  ) {
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
  const passphrase =
    /(?:password|passwd|passphrase)$/i.test(key) &&
    /^[A-Za-z]{2,}(?:-[A-Za-z]{2,}){2,}$/.test(value);
  if (passphrase) return true;
  if (!isTokenValue(value) || isDottedCode(value)) return false;
  if (DIAGNOSTIC_SECRET_KEY.test(key)) return value.length >= 8;
  if (secretKey) return value.length >= 8;
  return (
    tokenKey &&
    value.length >= 16 &&
    /^[A-Za-z0-9+/=_%-][A-Za-z0-9+/=_.%-]*[A-Za-z0-9+/=_%-]$/.test(value)
  );
}

export interface SecretPromptSpan {
  start: number;
  end: number;
}

interface DetectionView {
  text: string;
  starts?: number[];
  ends?: number[];
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
      if (hex !== undefined) {
        const digits = percent === undefined ? hex : percent.slice(-2);
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
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

function decodeMappedView(view: DetectionView): DetectionView {
  const matches = [...view.text.matchAll(ENCODED_CHARACTER_PATTERN)];
  if (matches.length === 0) return view;
  const chunks: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  function appendPlain(end: number): void {
    chunks.push(view.text.slice(cursor, end));
    for (; cursor < end; cursor += 1) {
      starts.push(view.starts?.[cursor] ?? cursor);
      ends.push(view.ends?.[cursor] ?? cursor + 1);
    }
  }
  for (const match of matches) {
    appendPlain(match.index);
    const decoded = decodeView(match[0]);
    const end = match.index + match[0].length;
    chunks.push(decoded);
    for (let index = 0; index < decoded.length; index += 1) {
      starts.push(view.starts?.[match.index] ?? match.index);
      ends.push(view.ends?.[end - 1] ?? end);
    }
    cursor = end;
  }
  appendPlain(view.text.length);
  return { text: chunks.join(""), starts, ends };
}

function detectionView(text: string): DetectionView {
  let view: DetectionView = { text };
  for (let pass = 0; pass < MAX_NORMALIZATION_PASSES; pass += 1) {
    const decoded = decodeMappedView(view);
    if (decoded === view) break;
    view = decoded;
  }
  return view;
}

function credentialRequest(line: string): boolean {
  const clean = line.replace(/[*_~`#[\]]/g, "").trim();
  if (FIELD_TITLE_PATTERN.test(clean) || FIELD_QUALIFIER_PATTERN.test(clean)) return true;
  const request =
    IMPERATIVE_CREDENTIAL_PATTERN.exec(clean) ?? INTERROGATIVE_CREDENTIAL_PATTERN.exec(clean);
  if (!request) return false;
  const before = clean.slice(0, request.index);
  return /(?:^|[.!?:,]\s*)(?:please\s+|(?:can|could|would)\s+you\s+)?$/i.test(before);
}

function requestsCredential(context: string): boolean {
  return detectionView(context)
    .text.split(/[\r\n]/)
    .some(credentialRequest);
}

function endsWithCredentialRequest(context: string): boolean {
  const lines = detectionView(context)
    .text.trimEnd()
    .split(/[\r\n]/);
  return credentialRequest(lines[lines.length - 1] ?? "");
}

function isOpaqueCharacter(character: string): boolean {
  return /^[A-Za-z0-9+/=_.%~-]$/.test(character);
}

function endOfOpaqueValue(text: string, start: number): number {
  let end = start;
  while (end < text.length && isOpaqueCharacter(text[end]!)) end += 1;
  while (end > start && text[end - 1] === ".") end -= 1;
  return end;
}

function literalSpans(text: string, pattern: RegExp): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(pattern.source, "g" + (pattern.ignoreCase ? "i" : ""));
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    let end = endOfOpaqueValue(text, match.index + match[0].length);
    while (end > match.index && text[end - 1] === ".") end -= 1;
    spans.push({ start: match.index, end });
    scanner.lastIndex = end;
  }
  return spans;
}

function privateKeySpans(text: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const markers = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;
  let opening: RegExpExecArray | undefined;
  for (const marker of text.matchAll(markers)) {
    if (marker[1] === "BEGIN") opening ??= marker;
    else if (opening) {
      spans.push({ start: opening.index, end: marker.index + marker[0].length });
      opening = undefined;
    }
  }
  if (opening) {
    const before = text.slice(text.lastIndexOf("\n", opening.index - 1) + 1, opening.index);
    const after = text.slice(opening.index + opening[0].length);
    const ownLine = /^\s{0,16}$/.test(before) && /^[ \t]{0,16}(?:\r?\n|$)/.test(after);
    const keyBody = /^\s*[A-Za-z0-9+/=]{16}/.test(after);
    if (ownLine || keyBody) {
      spans.push({ start: opening.index, end: text.length });
    }
  }
  return spans;
}

function assignmentSpans(text: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(ASSIGNMENT_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const key = match[1]!;
    const candidate =
      SECRET_KEY_PATTERN.test(key) ||
      TOKEN_KEY_PATTERN.test(key) ||
      ENV_TOKEN_KEY_PATTERN.test(key) ||
      DIAGNOSTIC_SECRET_KEY.test(key);
    if (!candidate) continue;
    const start = match.index + match[0].length;
    const before = text[match.index - 1];
    const query = before === "?" || before === "&";
    let end = start;
    while (end < text.length && !/[\s'"`;:,}\]\\()[<>?&#]/.test(text[end]!)) {
      end += 1;
    }
    const next = end;
    while (end > start && text[end - 1] === ".") end -= 1;
    const value = text.slice(start, end);
    if (isSecretAssignment({ key, value, query })) spans.push({ start, end });
    scanner.lastIndex = Math.max(scanner.lastIndex, next);
  }
  return spans;
}

function authorizationSpans(text: string): SecretPromptSpan[] {
  const spans = literalSpans(text, AUTHORIZATION_SCHEME_PATTERN);
  return spans.map((span) => {
    const scheme = /^(?:Bearer|Basic)[ \t]+/i.exec(text.slice(span.start, span.end));
    return { start: span.start + (scheme?.[0].length ?? 0), end: span.end };
  });
}

/** Merge a fixed number of sorted detector streams without sorting input-sized results. */
function mergeSpans(streams: SecretPromptSpan[][]): SecretPromptSpan[] {
  const indexes = streams.map(() => 0);
  const merged: SecretPromptSpan[] = [];
  while (true) {
    let selected = -1;
    let next: SecretPromptSpan | undefined;
    for (const [index, stream] of streams.entries()) {
      const span = stream[indexes[index]!];
      if (span && (!next || span.start < next.start)) {
        selected = index;
        next = span;
      }
    }
    if (!next) return merged;
    indexes[selected]! += 1;
    const previous = merged[merged.length - 1];
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end);
    else merged.push({ ...next });
  }
}

/** Original UTF-16 offsets; spans are sorted, merged, and never include surrounding prose. */
export function secretPromptSpans(text: string, context?: string): SecretPromptSpan[] {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return [];
  if (context !== undefined && /^\S+$/.test(text) && endsWithCredentialRequest(context)) {
    return [{ start: 0, end: text.length }];
  }
  const view = detectionView(text);
  const literals = [...LITERAL_PATTERNS, JWT_PATTERN];
  const streams = literals.map((pattern) => literalSpans(view.text, pattern));
  streams.push(
    privateKeySpans(view.text),
    assignmentSpans(view.text),
    authorizationSpans(view.text),
  );
  return mergeSpans(streams).map((span) => ({
    start: view.starts?.[span.start] ?? span.start,
    end: view.ends?.[span.end - 1] ?? span.end,
  }));
}

/** General chat preserves every ordinary byte and scans the complete input, regardless of size. */
export function redactSecretPrompt(text: string, context?: string): string {
  const spans = secretPromptSpans(text, context);
  if (spans.length === 0) return text;
  const chunks: string[] = [];
  let start = 0;
  for (const span of spans) {
    chunks.push(text.slice(start, span.start), SECRET_ANSWER_NOTICE);
    start = span.end;
  }
  chunks.push(text.slice(start));
  return chunks.join("");
}

/** Explicit question answers remain whole-field withholding, including shapeless credential replies. */
export function redactSecretAnswer(text: string, context?: string): string {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return text;
  if (context !== undefined && requestsCredential(context)) return SECRET_ANSWER_NOTICE;
  return secretPromptSpans(text).length > 0 ? SECRET_ANSWER_NOTICE : text;
}
