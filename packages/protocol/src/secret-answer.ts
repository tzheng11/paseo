interface IdentifierShape {
  alphabetic: number;
  wordCharacters: number;
  wordRuns: number;
  shortRuns: number;
  longNaturalWord: boolean;
  technical: boolean;
  digitRuns: number;
  doubleDigitRun: boolean;
  naturalWords: number;
}

function isTechnicalRun(run: string, vowels: number, adjacentDigit: boolean): boolean {
  const abbreviation =
    adjacentDigit &&
    run.length <= 4 &&
    (/^[A-Z]+$/.test(run) || /^[A-Z][a-z]{1,3}$/.test(run) || run.length <= 3);
  const syllabic =
    /^[A-Z]?[a-z]+$/.test(run) &&
    run.length >= 2 &&
    vowels / run.length >= 0.15 &&
    vowels / run.length <= 0.85;
  return abbreviation || syllabic;
}

function observeWord(run: string, adjacentDigit: boolean, shape: IdentifierShape): void {
  shape.alphabetic += run.length;
  const vowels = run.match(/[aeiouy]/gi)?.length ?? 0;
  const wordlike = run.length >= 3 && vowels > 0 && vowels / run.length <= 0.75;
  if (wordlike) {
    shape.wordCharacters += run.length;
    shape.wordRuns += 1;
  } else shape.shortRuns += 1;
  const natural = /^[A-Z]?[a-z]+$/.test(run) && run.length >= 3 && vowels >= 2;
  if (natural) {
    shape.naturalWords += 1;
    if (run.length >= 6) shape.longNaturalWord = true;
  }
  if (!isTechnicalRun(run, vowels, adjacentDigit)) shape.technical = false;
}

function measureIdentifier(runs: string[]): IdentifierShape {
  const shape: IdentifierShape = {
    alphabetic: 0,
    wordCharacters: 0,
    wordRuns: 0,
    shortRuns: 0,
    longNaturalWord: false,
    technical: true,
    digitRuns: 0,
    doubleDigitRun: false,
    naturalWords: 0,
  };
  for (const [index, run] of runs.entries()) {
    if (/^\d+$/.test(run)) {
      shape.digitRuns += 1;
      if (run.length === 2) shape.doubleDigitRun = true;
      if (run.length > 2) shape.technical = false;
    } else if (/[A-Za-z]/.test(run)) {
      const adjacentDigit =
        /^\d+$/.test(runs[index - 1] ?? "") || /^\d+$/.test(runs[index + 1] ?? "");
      observeWord(run, adjacentDigit, shape);
    }
  }
  return shape;
}

/**
 * Camel/acronym boundaries must form vowel-bearing word runs, rather than merely contain two
 * chance capitalized fragments. Short digit-bearing encoding/type names use a separate structural
 * route: one or two compact numeric tags surrounded entirely by syllabic words or adjacent acronyms.
 * This uses no vocabulary, source-name allowlist, or repository data at runtime.
 */
export function isWordlikeIdentifier(value: string): boolean {
  const name = value.replace(/\.[A-Za-z]{1,8}$/, "");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  // Uppercase underscore-separated constants encode word boundaries explicitly.
  if (/^[A-Z_$][A-Z0-9_$]*_[A-Z0-9_$]+$/.test(name)) return true;
  const runs = name.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|[_$]|$)|\d+|[_$]+/g);
  if (!runs || runs.join("") !== name) return false;
  const shape = measureIdentifier(runs);
  const minimumLetters = name.length < 16 ? 6 : 12;
  if (shape.alphabetic < minimumLetters) return false;
  const words =
    shape.wordCharacters / shape.alphabetic >= 0.8 && shape.shortRuns <= 3 && shape.longNaturalWord;
  const shortCamel =
    name.length < 16 &&
    shape.wordRuns >= 2 &&
    shape.wordCharacters === shape.alphabetic &&
    shape.shortRuns === 0;
  const compactNumbers = shape.digitRuns === 1 || (shape.digitRuns === 2 && shape.doubleDigitRun);
  const technical = shape.technical && compactNumbers && shape.naturalWords >= 1;
  return words || shortCamel || technical;
}

const CASE_INSENSITIVE_CREDENTIAL_NOUN =
  /\b(?:passwords?|passwds?|passphrases?|passcodes?|pin[ _-]+(?:codes?|numbers?)|your[ _-]+pins?|2fa|otp|one[ _-]+time[ _-]+codes?|(?:verification|recovery)[ _-]+codes?|(?:api|secret|access|private)[ _-]+keys?|(?:api|access|auth(?:entication)?|bearer|refresh|session|ssh|secret)[ _-]+tokens?|client[ _-]+secrets?)\b/i;
const UPPERCASE_PIN_NOUN = /\bPINs?\b/;

/** Credential nouns define the question policy independently of request wording. */
export function requestsCredential(context: string): boolean {
  return CASE_INSENSITIVE_CREDENTIAL_NOUN.test(context) || UPPERCASE_PIN_NOUN.test(context);
}

/** Retains the existing caller API; noun presence no longer depends on a sentence ending. */
export function endsWithCredentialRequest(context: string): boolean {
  return requestsCredential(context);
}

/** The entire answer is withheld so a matched prefix cannot leave a secret's suffix behind. */
export const SECRET_ANSWER_NOTICE =
  "[redacted:secret] This answer was withheld because it may contain a secret. Use a secret store instead.";

const MAX_NORMALIZATION_PASSES = 16;

// Ported from Studio's redact-segment-secrets.ts on origin/develop (8e33d51882ca).
// Answers use whole-field withholding rather than transcript substring replacement.
const SECRET_KEY_WORDS = String.raw`secret|pass|passwd|password|passphrase|passcode|pin|credentials?|private[_-]?key|secret[_-]?key|access[_-]?key|api[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|session[_-]?token`;
const LITERAL_PATTERNS: readonly RegExp[] = [
  /\bGOOG[0-9A-Z]{12,60}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,60}\b/,
  /\bya29\.[A-Za-z0-9._-]{20,}/,
  /\bsk-ant-[A-Za-z0-9._-]{20,}/,
  /(?<![A-Za-z0-9])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,512}|(?:[A-Za-z0-9]{1,16}-(?=[A-Za-z0-9_-]{40}))?[A-Za-z0-9]{20,512}[A-Za-z0-9_-]{0,512})/,
  /(?<![A-Za-z0-9])impr_(?:mcp|oat)_[A-Za-z0-9_-]{16,512}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bdtn_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}/,
  /\b(?:sk_(?:live|test)_|rk_(?:(?:live|test)_)?)[A-Za-z0-9_]{16,}/,
  /\bnpm_[A-Za-z0-9]{16,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\b(?:re_|sntrys_)[A-Za-z0-9_]{16,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bhf_[A-Za-z0-9_-]{16,}/,
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9_-]{16,}/,
];
const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.(?:[A-Za-z0-9_-]{1,4096}|(?=\.[A-Za-z0-9_-]{1}))(?:\.[A-Za-z0-9_-]{0,4096}){0,3}/;
// The same authorization schemes can be pasted without their HTTP header name.
const AUTHORIZATION_SCHEME_PATTERN = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9+/=_.%-]{16,4096}/i;
const SECRET_KEY_PATTERN = new RegExp(`(?:^|[_ .-])(?:${SECRET_KEY_WORDS})$`, "i");
const PASSWORD_KEY_PATTERN = /(?:^|[_ .-])(?:password|passwd|passphrase|passcode|pin|pwd)$/i;
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]{1,64})["']?\s{0,64}[:=]\s{0,64}["']?/g;
const TOKEN_KEY_PATTERN =
  /(?:(?:access|refresh|mcp)[_-]?token|(?<![A-Za-z0-9])id[_-]?token|(?<![A-Za-z0-9_.-])token|protection[_-]bypass)$/i;
const ENV_TOKEN_KEY_PATTERN = /(?:^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{0,60}_TOKEN$/;
const ENV_SECRET_KEY_PATTERN =
  /(?:^|_)(?:KEY|PASS|PWD|AUTH|COOKIE|DSN|JWT)$|^(?:PGPASSWORD|MYSQL_PWD)$/;
const NON_SECRET_KEY_PATTERN =
  /(?:^|_)(?:PUBLIC|SORT|PRIMARY|CACHE|FOREIGN|PARTITION|STORAGE|IDEMPOTENCY)_?KEY$|^KEY$|(?:^|_)ID$/i;
const HEX_LENGTHS = new Set([7, 8, 12, 32, 40, 64, 96, 128]);
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const WORDS_ONLY_VALUE =
  /^(?:[a-z]{1,24}(?:[_-][a-z]{1,24}){1,16}|[A-Z]{1,24}(?:[_-][A-Z]{1,24}){1,16}|(?:[A-Z][a-z]{0,24}[_-]?){2,8}|[a-z]{1,24}(?:[A-Z][a-z]{1,24}){1,16})$/;
const NON_SECRET_VALUE = /^(?:true|false|null|undefined|[\d.]+)$/i;
const SIGNED_URL_SIGNER_PARAM = /^x-(?:goog|amz)-credential$/i;
const DIAGNOSTIC_SECRET_KEY = /^(?:authorization|daemonPublicKeyB64|relayKey)$/i;
const PLACEHOLDER_WORDS = String.raw`required|optional|none|invalid|expired|missing|placeholder|example|password|passwd|passphrase|passcode|pin|true|false|null|undefined|not|enabled|disabled|and|or`;
const NON_SECRET_PASSWORD_VALUE = new RegExp(
  String.raw`^(?:${PLACEHOLDER_WORDS})(?:[_-](?:${PLACEHOLDER_WORDS}))*[;,.]?$`,
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

interface AssignmentCandidate {
  key: string;
  value: string;
  query: boolean;
}

function isExcludedKey(key: string): boolean {
  return NON_SECRET_KEY_PATTERN.test(keyWords(key));
}

function keyWords(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function isPasswordKey(key: string): boolean {
  return (
    PASSWORD_KEY_PATTERN.test(keyWords(key)) || /(?:^|_)PASS$|^(?:PGPASSWORD|MYSQL_PWD)$/.test(key)
  );
}

function isSecretKey(key: string): boolean {
  if (isExcludedKey(key)) return false;
  return (
    SECRET_KEY_PATTERN.test(keyWords(key)) ||
    isPasswordKey(key) ||
    TOKEN_KEY_PATTERN.test(key) ||
    ENV_TOKEN_KEY_PATTERN.test(key) ||
    ENV_SECRET_KEY_PATTERN.test(key) ||
    DIAGNOSTIC_SECRET_KEY.test(key)
  );
}

function isValueReference(value: string): boolean {
  return (
    /^(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|os\.environ(?:\[[^\]\r\n]+\])?|\$[A-Za-z_][A-Za-z0-9_]*|<[^<>\r\n]{1,256}>)$/.test(
      value,
    ) ||
    value.startsWith("${") ||
    value.startsWith("{{") ||
    value.startsWith("<") ||
    value.startsWith("[redacted")
  );
}

function isKnownIdentifier(value: string): boolean {
  return (
    UUID_PATTERN.test(value) ||
    (HEX_LENGTHS.has(value.length) && /^[\da-f]+$/i.test(value)) ||
    /^[a-z]+_[\da-fA-F]+$/.test(value)
  );
}

function isOrdinaryAnswerIdentifier(value: string): boolean {
  if (isWordlikeIdentifier(value)) return true;
  return (
    /^[a-z][a-z0-9]*(?:[-_.](?:[a-z][a-z0-9]*|\d+)){1,}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
  );
}

function isCodeValue(value: string): boolean {
  return (
    (/[A-Z]/.test(value) && /[a-z]/.test(value) && isWordlikeIdentifier(value)) ||
    /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(value) ||
    /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\([^)]*\)(?:\.[A-Za-z_$][\w$]*)?$/.test(value)
  );
}

function isSafeLocation(value: string): boolean {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|\/|\.\.?\/|~\/|[A-Za-z]:\\)/.test(value)) return true;
  return isWordlikePath(value);
}

function isShapedValue(value: string, minimum = 8): boolean {
  return (
    value.length >= minimum &&
    !isValueReference(value) &&
    !isSafeLocation(value) &&
    !isCodeValue(value) &&
    isTokenValue(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value)
  );
}

function isBenignCredentialValue(value: string): boolean {
  return (
    value === "" ||
    isValueReference(value) ||
    NON_SECRET_PASSWORD_VALUE.test(value) ||
    isCodeValue(value) ||
    isSafeLocation(value) ||
    isTypeValue(value) ||
    /^(?:[~^]\d+(?:\.\d+)*|\d+(?:\.\d+)+)(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
  );
}

function isTypeValue(value: string): boolean {
  return value.split("|").every((raw) => {
    const part = raw.trim();
    return (
      /^(?:string|number|boolean|bigint|symbol|unknown|never|object|any|void|null|undefined|Uint\d+Array|Int\d+Array|Float\d+Array)$/.test(
        part,
      ) ||
      /^[A-Z][a-z]+$/.test(part) ||
      (/^[A-Z]/.test(part) && /[a-z]/.test(part) && isWordlikeIdentifier(part))
    );
  });
}

function isSecretAssignment({ key, value, query }: AssignmentCandidate): boolean {
  return (
    !isExcludedKey(key) &&
    !(key.toLowerCase() === "pass" && /^\d+$/.test(value)) &&
    !(query && SIGNED_URL_SIGNER_PARAM.test(key)) &&
    !isBenignCredentialValue(value)
  );
}

function isBenignAnswerAssignment(text: string): boolean {
  const match = /^([A-Za-z0-9_.-]{1,64})[:=](.+)$/.exec(text);
  return match !== null && isBenignCredentialValue(match[2]!);
}

export interface SecretPromptSpan {
  start: number;
  end: number;
}

interface DetectionView {
  text: string;
  starts?: number[];
  ends?: number[];
  quotes?: Map<number, number>;
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

function isOpaqueCharacter(character: string): boolean {
  return /^[A-Za-z0-9+/=_.%~-]$/.test(character);
}

function isLiteralCharacter(view: DetectionView | undefined, index: number): boolean {
  const start = view?.starts?.[index];
  const end = view?.ends?.[index];
  return start === undefined || end === start + 1;
}

type ValueMode = "label" | "query" | "shell";

function quotePairs(text: string, view?: DetectionView): Map<number, number> {
  if (view?.quotes) return view.quotes;
  const pairs = new Map<number, number>();
  let opening = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '"' && character !== "'") continue;
    if (
      character === "'" &&
      /[A-Za-z]/.test(text[index - 1] ?? "") &&
      /[A-Za-z]/.test(text[index + 1] ?? "")
    )
      continue;
    if (opening < 0) opening = index;
    else if (
      character === text[opening] &&
      isLiteralCharacter(view, index) === isLiteralCharacter(view, opening)
    ) {
      pairs.set(opening, index);
      pairs.set(index, opening);
      opening = -1;
    }
  }
  if (view) view.quotes = pairs;
  return pairs;
}

function valueMode(text: string, index: number, label: string): ValueMode {
  if (text[index - 1] === "?" || text[index - 1] === "&") return "query";
  return label.includes("=") ? "shell" : "label";
}

function trimValueTerminators(
  text: string,
  start: number,
  end: number,
  view?: DetectionView,
): number {
  let parentheses = 0;
  for (let index = start; index < end; index += 1) {
    if (!isLiteralCharacter(view, index)) continue;
    if (text[index] === "(") parentheses += 1;
    else if (text[index] === ")") parentheses -= 1;
  }
  while (end > start) {
    const last = text[end - 1]!;
    if (!isLiteralCharacter(view, end - 1)) break;
    if (last === ")" && parentheses < 0) {
      end -= 1;
      parentheses += 1;
    } else if (/[;,}]/.test(last)) end -= 1;
    else break;
  }
  return end;
}

function assignedValueEnd(
  text: string,
  start: number,
  view?: DetectionView,
  mode: ValueMode = "label",
): number {
  const opening = text[start - 1];
  if (opening === '"' || opening === "'") {
    const paired = quotePairs(text, view).get(start - 1);
    if (paired !== undefined) return paired < start ? start : paired;
  }
  // A missing closing quote cannot consume subsequent prose or another line.
  let end = start;
  while (end < text.length) {
    const literal = isLiteralCharacter(view, end);
    if (literal && /\s/.test(text[end]!)) break;
    if (literal && mode === "query" && /[&#]/.test(text[end]!)) break;
    if (
      literal &&
      mode === "shell" &&
      (text[end] === ";" || text[end] === "|" || text.slice(end, end + 2) === "&&")
    )
      break;
    end += 1;
  }
  return trimValueTerminators(text, start, end, view);
}

function assignedValue(text: string, start: number, end: number, view?: DetectionView): string {
  if (!view?.starts) return text.slice(start, end);
  const characters: string[] = [];
  for (let index = start; index < end; index += 1) {
    const character = text[index]!;
    const encodedDelimiter = !isLiteralCharacter(view, index) && !isOpaqueCharacter(character);
    characters.push(encodedDelimiter ? `%${character.charCodeAt(0).toString(16)}` : character);
  }
  return characters.join("");
}

function endOfOpaqueValue(text: string, start: number, view?: DetectionView): number {
  let end = start;
  while (end < text.length && (isOpaqueCharacter(text[end]!) || !isLiteralCharacter(view, end)))
    end += 1;
  while (end > start && text[end - 1] === ".") end -= 1;
  return end;
}

function literalSpans(text: string, pattern: RegExp, view?: DetectionView): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(pattern.source, "g" + (pattern.ignoreCase ? "i" : ""));
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    let end = endOfOpaqueValue(text, match.index + match[0].length, view);
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

function assignmentSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(ASSIGNMENT_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const key = match[1]!;
    if (!isSecretKey(key)) continue;
    if (/^(?:pass|credentials)$/i.test(key) && !isFieldPosition(text, match.index)) continue;
    const start = match.index + match[0].length;
    const before = text[match.index - 1];
    const query = before === "?" || before === "&";
    const end = assignedValueEnd(text, start, view, valueMode(text, match.index, match[0]));
    const next = end;
    const value = assignedValue(text, start, end, view);
    if (value === "await" && awaitsReference(text, end)) continue;
    if (isSecretAssignment({ key, value, query })) spans.push({ start, end });
    scanner.lastIndex = Math.max(scanner.lastIndex, next);
  }
  return spans;
}

function isFieldPosition(text: string, index: number): boolean {
  const before = text
    .slice(Math.max(0, index - 128), index)
    .split(/\r?\n/)
    .at(-1)!;
  return (
    /^\s*$/.test(before) ||
    /[{"';]\s*$/.test(before) ||
    /(?:^|[;{}])\s*(?:export|const|let|var)\s+$/.test(before)
  );
}

function awaitsReference(text: string, index: number): boolean {
  const call = /[ \t]+(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\(/y;
  call.lastIndex = index;
  return call.test(text);
}

function labelledValueSpans(
  text: string,
  pattern: RegExp,
  view?: DetectionView,
): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = assignedValueEnd(text, start, view, valueMode(text, match.index, match[0]));
    const next = end;
    const value = assignedValue(text, start, end, view);
    if (!isBenignCredentialValue(value)) spans.push({ start, end });
    scanner.lastIndex = Math.max(scanner.lastIndex, next);
  }
  return spans;
}

function naturalCredentialSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  return labelledValueSpans(
    text,
    /\b(?:password|passwd|passphrase|api[ _-]?key|secret[ _-]?key)(?:\s{1,16}is\s{1,16}|\s{0,16}[:=]\s{0,16})["']?/gi,
    view,
  );
}

function flagSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  return labelledValueSpans(
    text,
    /--(?:password|passwd|passphrase|token|api[-_]key|secret)(?:=|[ \t]{1,16})["']?/gi,
    view,
  );
}

function userPasswordSpans(
  text: string,
  pattern: RegExp,
  url: boolean,
  view?: DetectionView,
): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    let start = match.index + match[0].length;
    if (url) {
      if (text.slice(start, start + 3) !== "://") continue;
      start += 3;
    }
    let end = start;
    while (end < text.length) {
      const literal = isLiteralCharacter(view, end);
      if (literal && /[\s'"`<>]/.test(text[end]!)) break;
      if (url && literal && /[/?#]/.test(text[end]!)) break;
      end += 1;
    }
    const authority = text.slice(start, end);
    const at = url ? authority.lastIndexOf("@") : authority.length;
    const colon = authority.indexOf(":");
    if (colon >= 0 && at > colon) {
      const passwordStart = start + colon + 1;
      const passwordEnd = start + at;
      const password = text.slice(passwordStart, passwordEnd);
      if (isShapedValue(password)) spans.push({ start: passwordStart, end: passwordEnd });
    }
    scanner.lastIndex = Math.max(scanner.lastIndex, end);
  }
  return spans;
}

function urlPasswordSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  return userPasswordSpans(text, /[A-Za-z][A-Za-z0-9+.-]*/g, true, view);
}

function curlUserSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  return userPasswordSpans(text, /(?:^|\s)(?:-u|--user)(?:=|[ \t]{1,16})["']?/g, false, view);
}

function cookieSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = /\b(?:Cookie|Set-Cookie):[ \t]{0,16}/gi;
  let header: RegExpExecArray | null;
  while ((header = scanner.exec(text)) !== null) {
    const start = header.index + header[0].length;
    let end = start;
    while (end < text.length && !(text[end] === "\n" && isLiteralCharacter(view, end))) end += 1;
    const line = text.slice(start, end);
    const entries = /\b[A-Za-z0-9_-]{1,64}=/g;
    let entry: RegExpExecArray | null;
    while ((entry = entries.exec(line)) !== null) {
      const valueStart = start + entry.index + entry[0].length;
      let valueEnd = Math.min(end, assignedValueEnd(text, valueStart, view));
      for (let index = valueStart; index < valueEnd; index += 1) {
        if (text[index] === ";" && isLiteralCharacter(view, index)) {
          valueEnd = index;
          break;
        }
      }
      const value = assignedValue(text, valueStart, valueEnd, view);
      if (isShapedValue(value)) spans.push({ start: valueStart, end: valueEnd });
      entries.lastIndex = Math.max(entries.lastIndex, valueEnd - start);
    }
    scanner.lastIndex = end;
  }
  return spans;
}

function entropyOf(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const proportion = count / value.length;
    entropy -= proportion * Math.log2(proportion);
  }
  return entropy;
}

function isEntropyValue(value: string): boolean {
  if (
    value.length < 32 ||
    isKnownIdentifier(value) ||
    isWordlikePath(value) ||
    isWordlikeIdentifier(value)
  )
    return false;
  const mixed = /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
  if (!mixed || !isTokenValue(value)) return false;
  return entropyOf(value) >= 3.5;
}

function isWordlikePath(value: string): boolean {
  if (!value.includes("/")) return false;
  const parts = value.split("/").filter((part) => part !== "");
  const readableDirectory = /^(?:[a-z][a-z0-9_.-]*|[A-Z][a-z]{1,23})$/.test(parts[0] ?? "");
  const filename = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(parts[parts.length - 1] ?? "");
  if (!readableDirectory && !filename) return false;
  if (parts.every(isWordlikePathSegment)) return true;
  // Two readable directories establish a local path even when generated filenames are opaque.
  return (
    parts.length >= 3 &&
    isWordlikePathSegment(parts[0]!) &&
    isWordlikePathSegment(parts[1]!) &&
    parts.every((part) => !/[+=]/.test(part))
  );
}

function isWordlikePathSegment(part: string): boolean {
  return (
    isWordlikeIdentifier(part) ||
    isKnownIdentifier(part) ||
    /^[A-Za-z]{1,24}$/.test(part) ||
    /^[a-z0-9_.-]+$/.test(part) ||
    /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){1,}-[A-Za-z0-9]+$/.test(part)
  );
}

function entropySpans(text: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  // Chunk exclusions keep URLs, data URIs, integrity hashes and path segments readable.
  for (const chunk of text.matchAll(/\S+/g)) {
    if (
      /(?:data:[^\s]*base64,|[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|sha(?:1|224|256|384|512)-)/i.test(
        chunk[0],
      )
    )
      continue;
    const assigned = /^([A-Za-z0-9_.-]{1,64})=/.exec(chunk[0]);
    if (assigned && isExcludedKey(assigned[1]!)) continue;
    for (const candidate of chunk[0].matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
      const value = candidate[0];
      if (!isEntropyValue(value)) continue;
      const start = chunk.index + candidate.index;
      spans.push({ start, end: start + value.length });
    }
  }
  return spans;
}

function benignAssignmentSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = new RegExp(ASSIGNMENT_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (!isExcludedKey(match[1]!)) continue;
    const start = match.index + match[0].length;
    const end = assignedValueEnd(text, start, view);
    spans.push({ start, end });
    scanner.lastIndex = Math.max(scanner.lastIndex, end);
  }
  return spans;
}

function excludeSpans(
  spans: SecretPromptSpan[],
  exclusions: SecretPromptSpan[],
): SecretPromptSpan[] {
  const kept: SecretPromptSpan[] = [];
  let index = 0;
  for (const span of spans) {
    while (exclusions[index] && exclusions[index]!.end <= span.start) index += 1;
    const exclusion = exclusions[index];
    if (!exclusion || exclusion.start >= span.end) kept.push(span);
  }
  return kept;
}

function authorizationSpans(text: string, view?: DetectionView): SecretPromptSpan[] {
  const spans = literalSpans(text, AUTHORIZATION_SCHEME_PATTERN, view);
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
function scanSecretSpans(text: string, includeEntropy: boolean): SecretPromptSpan[] {
  const view = detectionView(text);
  const literals = [...LITERAL_PATTERNS, JWT_PATTERN];
  const streams = literals.map((pattern) => literalSpans(view.text, pattern, view));
  streams.push(
    privateKeySpans(view.text),
    assignmentSpans(view.text, view),
    authorizationSpans(view.text, view),
    urlPasswordSpans(view.text, view),
    curlUserSpans(view.text, view),
    flagSpans(view.text, view),
    cookieSpans(view.text, view),
    naturalCredentialSpans(view.text, view),
  );
  if (includeEntropy)
    streams.push(excludeSpans(entropySpans(view.text), benignAssignmentSpans(view.text, view)));
  return mergeSpans(streams).map((span) => ({
    start: view.starts?.[span.start] ?? span.start,
    end: view.ends?.[span.end - 1] ?? span.end,
  }));
}

/** Original UTF-16 offsets; spans are sorted, merged, and never include surrounding prose. */
export function secretPromptSpans(text: string, context?: string): SecretPromptSpan[] {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return [];
  if (
    context !== undefined &&
    !/^(?:yes|no)$/i.test(text) &&
    /^\S+$/.test(text) &&
    endsWithCredentialRequest(detectionView(context).text)
  ) {
    return [{ start: 0, end: text.length }];
  }
  return scanSecretSpans(text, true);
}

/** Routing keys use explicit credential formats, never value entropy or conversational context. */
export function redactSecretKey(text: string): string {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return text;
  return scanSecretSpans(text, false).length > 0 ? SECRET_ANSWER_NOTICE : text;
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
  if (/^(?:yes|no)$/i.test(text)) return text;
  if (context !== undefined && requestsCredential(detectionView(context).text))
    return SECRET_ANSWER_NOTICE;
  const neutralSecret =
    /^\S{16,}$/.test(text) &&
    /[A-Za-z]/.test(text) &&
    /\d/.test(text) &&
    !isKnownIdentifier(text) &&
    !isOrdinaryAnswerIdentifier(text) &&
    !isBenignAnswerAssignment(text) &&
    !isSafeLocation(text) &&
    !isValueReference(text) &&
    !/^(?:data:|sha(?:1|224|256|384|512)-)/i.test(text);
  if (neutralSecret) return SECRET_ANSWER_NOTICE;
  return secretPromptSpans(text).length > 0 ? SECRET_ANSWER_NOTICE : text;
}
