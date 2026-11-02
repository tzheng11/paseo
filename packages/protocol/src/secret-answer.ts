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

function isSyllabicDigitWord(run: string, vowels: number): boolean {
  return /^[A-Z]?[a-z]+$/.test(run) && run.length >= 2 && vowels > 0 && vowels / run.length <= 0.75;
}

function isCompactDigitAbbreviation(run: string): boolean {
  return run.length <= 4 && (/^[A-Z]+$/.test(run) || /^[A-Z][a-z]{1,3}$/.test(run));
}

interface DigitWordShape {
  alphabetic: number;
  naturalLetters: number;
  naturalWords: number;
  longWord: boolean;
  digits: number;
  taggedDigits: boolean;
  acronyms: number;
  maxAcronym: number;
}

function hasStrongDigitWordShape(shape: DigitWordShape): boolean {
  if (shape.digits > 2) return false;
  const naturalRatio = shape.naturalLetters / shape.alphabetic;
  if (naturalRatio >= 0.95 && shape.longWord) return true;
  const compactTag =
    shape.digits === 1 && shape.taggedDigits && shape.acronyms <= 1 && shape.maxAcronym <= 2;
  const words = shape.naturalWords >= 3 || (shape.longWord && shape.naturalWords >= 2);
  return compactTag && naturalRatio >= 0.8 && words;
}

function isNumericWordTag(runs: string[], index: number): boolean {
  return (
    index >= 2 &&
    (runs[index]?.length ?? 0) <= 2 &&
    /^[A-Z]{1,2}$/.test(runs[index - 1] ?? "") &&
    /^[A-Z][a-z]+$/.test(runs[index + 1] ?? "")
  );
}

function hasStructuredDigitWords(runs: string[]): boolean {
  const shape: DigitWordShape = {
    alphabetic: 0,
    naturalLetters: 0,
    naturalWords: 0,
    longWord: false,
    digits: 0,
    taggedDigits: false,
    acronyms: 0,
    maxAcronym: 0,
  };
  for (const [index, run] of runs.entries()) {
    if (/^\d+$/.test(run)) {
      shape.digits += 1;
      if (isNumericWordTag(runs, index)) shape.taggedDigits = true;
      continue;
    }
    if (!/[A-Za-z]/.test(run)) continue;
    shape.alphabetic += run.length;
    const vowels = run.match(/[aeiouy]/gi)?.length ?? 0;
    const previousDigit = /^\d+$/.test(runs[index - 1] ?? "");
    if (previousDigit && /^[a-z]/.test(run)) return false;
    if (isSyllabicDigitWord(run, vowels)) {
      shape.naturalLetters += run.length;
      if (run.length >= 3) shape.naturalWords += 1;
      if (run.length >= 6 && vowels >= 2) shape.longWord = true;
    } else {
      const adjacentDigit = previousDigit || /^\d+$/.test(runs[index + 1] ?? "");
      const initial = index === 0 && /^[A-Z]$/.test(run);
      if (!(initial || (adjacentDigit && isCompactDigitAbbreviation(run)))) return false;
      shape.acronyms += 1;
      shape.maxAcronym = Math.max(shape.maxAcronym, run.length);
    }
  }
  return hasStrongDigitWordShape(shape);
}

function hasCoherentLetterCase(runs: string[]): boolean {
  let natural = 0;
  for (const [index, run] of runs.entries()) {
    if (/^[_$]+$/.test(run)) continue;
    if (/^[A-Z]?[a-z]+$/.test(run) && run.length >= 2) natural += 1;
    else if (/^[A-Z]{2,5}$/.test(run)) continue;
    else {
      const terminalUnit =
        index === runs.length - 1 &&
        /^[A-Z]$/.test(run) &&
        /^[A-Z][a-z]$/.test(runs[index - 1] ?? "") &&
        natural >= 3;
      if (!terminalUnit) return false;
    }
  }
  return natural >= 2;
}

function hasTechnicalNumericLayout(name: string): boolean {
  // Dimension tags, standards numbers, dated model versions, and compact machine-size tags.
  // Every route requires complete case-delimited words around the numeric notation.
  const dimension = /^[A-Z][a-z]{3,}\d{1,2}[a-z]\d{1,2}(?:[A-Z][a-z]{2,}){2,}$/.test(name);
  const standard = /^[a-z]\d{3}(?:[A-Z][a-z]{1,}){2,}\d{1,2}[A-Z][a-z]{3,}$/.test(name);
  const machineTag =
    /^[A-Z]{2,3}\d{1,2}(?:[A-Z][a-z]{3,}){2,}[A-Z]\d{1,2}[a-z]{2}[A-Z](?:[A-Z][a-z]{3,})+$/.test(
      name,
    );
  const datedTag = /^[A-Z][a-z]{2,}\d[a-z][A-Z][a-z]{2,}(?:19|20)\d{6}[A-Z][a-z]{3,}$/.test(name);
  return dimension || standard || machineTag || datedTag;
}

function hasStructuredNumericLayout(name: string): boolean {
  const shortPrefix = /^[a-z]{1,2}[A-Z][a-z]{2,}\d{2}(?:[A-Z][a-z]{2,}){2,}$/.test(name);
  const embeddedInitialism = /^[a-z]{6,}[A-Z][A-Z][a-z]{2,}\d{1,2}[A-Z][a-z]{5,}$/.test(name);
  if (shortPrefix || embeddedInitialism) return true;
  if (!/^[A-Za-z]\d{3}(?:[A-Z][a-z]{2,}){2,}$/.test(name)) return false;
  const words = name.slice(4).match(/[A-Z][a-z]+/g) ?? [];
  const letters = words.reduce((sum, word) => sum + word.length, 0);
  return letters >= 12 && (words.length >= 3 || words.some((word) => word.length >= 8));
}

function hasWordlikeIdentifierShape(name: string, shape: IdentifierShape): boolean {
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

/**
 * Camel/acronym boundaries must form vowel-bearing word runs, rather than merely contain two
 * chance capitalized fragments. Short digit-bearing encoding/type names use a separate structural
 * route: one or two compact numeric tags surrounded entirely by syllabic words or adjacent acronyms.
 * Long digit-bearing names require at most two numeric tags and complete syllabic case runs.
 * The main route requires 95% syllabic letters and a six-letter run with two vowels; a single
 * compact uppercase numeric tag surrounded by multiple complete words may use 80% syllabic letters.
 * Explicit file extensions retain the ordinary filename treatment.
 * This uses no vocabulary, source-name allowlist, or repository data at runtime.
 */
export function isWordlikeIdentifier(value: string): boolean {
  const name = value.replace(/\.[A-Za-z]{1,8}$/, "");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  // Uppercase underscore-separated constants encode word boundaries explicitly.
  if (/^[A-Z_$][A-Z0-9_$]*_[A-Z0-9_$]+$/.test(name)) return true;
  if (hasTechnicalNumericLayout(name)) return true;
  const runs = name.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|[_$]|$)|\d+|[_$]+/g);
  if (!runs || runs.join("") !== name) return false;
  if (!/\d/.test(name) && hasCoherentLetterCase(runs)) return true;
  if (
    name === value &&
    name.length >= 16 &&
    /\d/.test(name) &&
    !hasStructuredDigitWords(runs) &&
    !hasStructuredNumericLayout(name)
  )
    return false;
  const shape = measureIdentifier(runs);
  return hasWordlikeIdentifierShape(name, shape);
}

const CASE_INSENSITIVE_CREDENTIAL_NOUN =
  /\b(?:passwords?|passwds?|pwds?|passphrases?|pass[ ]?codes?|credentials?|pin (?:codes?|numbers?)|your pins?|2fa|otp|mfa|totp|one time codes?|(?:verification|recovery|backup|authenticator(?: app)?) codes?|codes? (?:from|in) (?:your |the )?authenticator(?: app)?|\d+ digit codes?|(?:api|secret|access|private|hmac|signing|encryption|ssh|service account) keys?|(?:api|access|auth(?:entication)?|bearer|refresh|session|ssh|secret) tokens?)\b/i;
const UPPERCASE_PIN_NOUN = /\bPINs?\b/;
const BARE_CREDENTIAL_ENDING = new RegExp(
  `(?:${CASE_INSENSITIVE_CREDENTIAL_NOUN.source}|\\bPINs?\\b|\\bsecrets?\\b|\\bpass\\b)$`,
  "i",
);
const CREDENTIAL_VALUE_VERB =
  /^(?:please\s+)?(?:provide|enter|paste|send|share|give|type|supply|input|need|tell me)\b/i;
const MODAL_CREDENTIAL_VALUE_VERB =
  /^(?:can|could|would|will|may)\s+(?:you|i|we)\s+(?:please\s+)?(?:provide|enter|paste|send|share|give|type|supply|input|have|tell me)\b/i;
const SECRET_NOUN_PREFIX =
  /\b(?:the|your|my|our|their|his|her|its|a|an|webhook|signing|shared|app|jwt|client|api)\s*$/i;
const SECRET_NOUN_FOLLOWER =
  /^\s+(?:is|are|was|were|for|to|from|of|in|on|please|now|below|here|when|that|you|we|i)\b/i;

function normalizeCredentialQuestion(context: string): string {
  return context
    .replace(/\bAPIKEY(S?)\b/gi, "API KEY$1")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bAPIKEY(S?)\b/gi, "API KEY$1")
    .replace(/\b2 FA\b/gi, "2FA");
}

function credentialRequestSentences(context: string): string[] {
  return context.split(/[.!?\n]+/).map((sentence) => sentence.trim());
}

function hasCredentialValueRequestSyntax(sentence: string): boolean {
  if (CREDENTIAL_VALUE_VERB.test(sentence) || MODAL_CREDENTIAL_VALUE_VERB.test(sentence))
    return true;
  if (/^(?:i|we)\s+(?:really\s+)?need\b/i.test(sentence)) return true;
  if (/^what(?:'s|\s+is|\s+are)\s+(?!a\s|an\s)/i.test(sentence)) return true;
  if (/^what\s+.*\bshould i use\b/i.test(sentence)) return true;
  return /[,;:]\s*(?:please\s+)?(?:provide|enter|paste|send|share|give|type|supply|input|need|tell me)\b/i.test(
    sentence,
  );
}

function hasStandaloneSecretNoun(context: string): boolean {
  for (const sentence of credentialRequestSentences(context)) {
    const asksForValue = hasCredentialValueRequestSyntax(sentence);
    for (const match of sentence.matchAll(/\bsecrets?\b/gi)) {
      const after = sentence.slice(
        match.index + match[0].length,
        match.index + match[0].length + 128,
      );
      // A following ordinary word makes "secret" an adjective (secret store/name/scanning, etc.).
      if (/^\s+[A-Za-z]/.test(after) && !SECRET_NOUN_FOLLOWER.test(after)) continue;
      const before = sentence.slice(Math.max(0, match.index - 128), match.index);
      if (SECRET_NOUN_PREFIX.test(before) || match.index === 0 || asksForValue) return true;
    }
  }
  return false;
}

function hasPassValueNoun(context: string): boolean {
  if (/^\s*pass\s*[:?]?\s*$/i.test(context)) return true;
  return credentialRequestSentences(context).some(
    (sentence) => /\bpass\b/i.test(sentence) && hasCredentialValueRequestSyntax(sentence),
  );
}

/** Structured questions use normalized credential nouns independently of request wording. */
export function requestsCredential(context: string): boolean {
  const normalized = normalizeCredentialQuestion(context);
  return (
    CASE_INSENSITIVE_CREDENTIAL_NOUN.test(normalized) ||
    UPPERCASE_PIN_NOUN.test(normalized) ||
    hasStandaloneSecretNoun(normalized) ||
    hasPassValueNoun(normalized)
  );
}

function isBareCredentialLabel(context: string): boolean {
  const label = context
    .trim()
    .replace(/[?:.,;]+$/, "")
    .replace(/\s*\(optional\)\s*$/i, "")
    .replace(/\s+(?:optional|please)\s*$/i, "")
    .replace(/[?:.,;]+$/, "")
    .trim();
  if (!label || label.split(/\s+/).length > 10) return false;
  if (/\b(?:is|are|was|were|has|have|had|will|should|could|would|must|does|did|do)\b/i.test(label))
    return false;
  if (/^(?:i|we|they|he|she|it|done|fixed|updated|added|reset|rotate|check)\b/i.test(label))
    return false;
  const ending = label.replace(/\s+(?:for|of|on)\s+.*$/i, "");
  if (
    /\b(?:needed|required|validation|format|manager|management|reset|bug|code\s+changes?)$/i.test(
      ending,
    )
  )
    return false;
  return BARE_CREDENTIAL_ENDING.test(ending) && requestsCredential(ending);
}

/** Chat needs an actual value request sentence or a final credential field label. */
export function endsWithCredentialRequest(context: string): boolean {
  const normalized = normalizeCredentialQuestion(context);
  for (const sentence of credentialRequestSentences(normalized)) {
    if (requestsCredential(sentence) && hasCredentialValueRequestSyntax(sentence)) return true;
  }
  const lastLine = normalized.trim().split(/\n/).at(-1) ?? "";
  return isBareCredentialLabel(lastLine);
}

/** The entire answer is withheld so a matched prefix cannot leave a secret's suffix behind. */
export const SECRET_ANSWER_NOTICE =
  "[redacted:secret] This answer was withheld because it may contain a secret. Use a secret store instead.";

const MAX_NORMALIZATION_PASSES = 16;

const LITERAL_PATTERNS: readonly RegExp[] = [
  /\bGOOG[0-9A-Z]{12,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/,
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
  /\b(?:re_|sntrys_|sntryu_)[A-Za-z0-9_]{16,}/,
  /(?<![A-Za-z0-9_])[a-z]+_[\da-fA-F]{32,}(?![A-Za-z0-9_])/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bhf_[A-Za-z0-9_-]{16,}/,
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9_-]{16,}/,
];

const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.(?:[A-Za-z0-9_-]{1,4096}|(?=\.[A-Za-z0-9_-]{1}))(?:\.[A-Za-z0-9_-]{0,4096}){0,3}/;

// The same authorization schemes can be pasted without their HTTP header name.

const HEX_LENGTHS = new Set([7, 8, 12, 32, 40, 64, 96, 128]);

const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

const ENCODED_CHARACTER_PATTERN =
  /%((?:25)*[\da-f]{2})|\\u([\da-f]{4})|\\x([\da-f]{2})|&#x([\da-f]{1,6});?|&#(\d{1,7});?|&(colon|equals|quot|apos);|\\([\\"'/nrt_*~-])/gi;
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

function isOpaqueCharacter(character: string): boolean {
  return /^[A-Za-z0-9+/=_.%~-]$/.test(character);
}

function isLiteralCharacter(view: DetectionView | undefined, index: number): boolean {
  const start = view?.starts?.[index];
  const end = view?.ends?.[index];
  return start === undefined || end === start + 1;
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

function tokenCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9._/+=-]/.test(character);
}

/**
 * Match a known literal whose opaque value continues over exactly one LF/CRLF.
 * Every byte on the continuation line must belong to the token alphabet. The
 * result uses offsets in the supplied text, including the removed line ending.
 */
function wrappedMatchStart(joined: string, firstLength: number, scanners: RegExp[]): number | null {
  let selectedStart: number | null = null;
  for (const scanner of scanners) {
    scanner.lastIndex = 0;
    for (let match = scanner.exec(joined); match; match = scanner.exec(joined)) {
      if (match.index >= firstLength) break;
      if (match[0].length === 0) {
        scanner.lastIndex += 1;
        continue;
      }
      let end = match.index + match[0].length;
      // A fixed-width provider pattern can finish before the physical wrap;
      // extend only through the same opaque token, never through prose.
      while (tokenCharacter(joined[end])) end += 1;
      if (end !== joined.length) continue;
      selectedStart = selectedStart === null ? match.index : Math.min(selectedStart, match.index);
    }
  }
  return selectedStart;
}

function isWrappedTokenLine(text: string, start: number, end: number): boolean {
  if (start >= end) return false;
  for (let index = start; index < end; index += 1) {
    if (!tokenCharacter(text[index])) return false;
  }
  return true;
}

function continuedWrappedTokenEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && (text[end] === "\r" || text[end] === "\n")) {
    let nextStart = end;
    if (text[nextStart] === "\r") nextStart += 1;
    if (text[nextStart] === "\n") nextStart += 1;
    let nextEnd = nextStart;
    while (nextEnd < text.length && tokenCharacter(text[nextEnd])) nextEnd += 1;
    if (
      nextEnd === nextStart ||
      (nextEnd < text.length && text[nextEnd] !== "\n" && text[nextEnd] !== "\r")
    )
      break;
    end = nextEnd;
  }
  return end;
}

function wrappedLiteralPair(
  text: string,
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
  scanners: RegExp[],
): SecretPromptSpan | null {
  if (firstStart >= firstEnd || !isWrappedTokenLine(text, secondStart, secondEnd)) return null;
  const first = text.slice(firstStart, firstEnd);
  const joined = first + text.slice(secondStart, secondEnd);
  const selectedStart = wrappedMatchStart(joined, first.length, scanners);
  if (selectedStart === null) return null;
  return { start: firstStart + selectedStart, end: secondEnd };
}

function wrappedLiteralSpans(text: string, patterns: readonly RegExp[]): SecretPromptSpan[] {
  const scanners = patterns.map(
    // A terminal word boundary after a provider's maximum width must not make
    // an opaque continuation disappear (for example GOOG{12,60} followed by
    // more token bytes). Prefix boundaries remain intact.
    (pattern) =>
      new RegExp(pattern.source.replace(/\\b$/, ""), pattern.flags.replace(/[gy]/g, "") + "g"),
  );
  const spans: SecretPromptSpan[] = [];
  let firstStart = 0;
  let continuedEnd = 0;
  while (firstStart < text.length) {
    const newline = text.indexOf("\n", firstStart);
    if (newline < 0) break;
    const firstEnd = text[newline - 1] === "\r" ? newline - 1 : newline;
    const secondStart = newline + 1;
    const nextNewline = text.indexOf("\n", secondStart);
    const rawSecondEnd = nextNewline < 0 ? text.length : nextNewline;
    const secondEnd = text[rawSecondEnd - 1] === "\r" ? rawSecondEnd - 1 : rawSecondEnd;
    const span = wrappedLiteralPair(text, firstStart, firstEnd, secondStart, secondEnd, scanners);
    if (span) {
      // Later pairs in the same token-only chain have the same final boundary.
      if (span.end > continuedEnd) continuedEnd = continuedWrappedTokenEnd(text, span.end);
      spans.push({ start: span.start, end: continuedEnd });
    }
    firstStart = secondStart;
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
      spans.push({
        start: opening.index,
        end: marker.index + marker[0].length,
      });
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

function isKnownIdentifier(value: string): boolean {
  return (
    UUID_PATTERN.test(value) ||
    (HEX_LENGTHS.has(value.length) && /^[\da-f]+$/i.test(value)) ||
    /^[a-z]+_[\da-fA-F]{1,24}$/.test(value)
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

function isDelimitedIdentifier(value: string): boolean {
  const parts = value.split(/[-_]/);
  return (
    parts.length >= 2 &&
    parts.some((part) => /^[A-Za-z]{3,}$/.test(part)) &&
    parts.every(
      (part) =>
        /^[A-Za-z]+$/.test(part) ||
        /^[a-z0-9]+$/.test(part) ||
        /^\d+$/.test(part) ||
        isKnownIdentifier(part) ||
        isWordlikeIdentifier(part) ||
        /^[A-Za-z]{1,3}\d{1,6}$/.test(part),
    )
  );
}

function isWordlikePath(value: string): boolean {
  if (isFortyCharacterBase64(value)) return false;
  if (!value.includes("/")) return false;
  const parts = value.split("/").filter((part) => part !== "");
  const readableDirectory = /^(?:[a-z][a-z0-9_.-]*|[A-Z][a-z]{1,23})$/.test(parts[0] ?? "");
  const filename = /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?:-\d+)?)*$/.test(
    parts[parts.length - 1] ?? "",
  );
  if (parts.every(isWordlikePathSegment)) return true;
  if (!readableDirectory && !filename) return false;
  // Two readable directories establish a local path even when generated filenames are opaque.
  return (
    filename &&
    parts.length >= 3 &&
    isWordlikePathSegment(parts[0]!) &&
    isWordlikePathSegment(parts[1]!) &&
    parts.every((part) => !/[+=]/.test(part))
  );
}

function isFortyCharacterBase64(value: string): boolean {
  return (
    value.length === 40 &&
    /[+/]/.test(value) &&
    /^[A-Za-z0-9+/=]+$/.test(value) &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value)
  );
}

function isWordlikePathSegment(part: string): boolean {
  return (
    /^@[a-z][a-z0-9._-]*$/.test(part) ||
    isWordlikeIdentifier(part) ||
    /^[A-Z][a-z]{2,}\d{1,3}$/.test(part) ||
    isDelimitedIdentifier(part) ||
    isKnownIdentifier(part) ||
    /^[A-Za-z]{1,24}$/.test(part) ||
    /^[a-z0-9_.-]+$/.test(part) ||
    /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){1,}-[A-Za-z0-9]+$/.test(part)
  );
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

function unwrapNeutralAnswer(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end) {
    while (start < end && /\s/.test(text[start]!)) start += 1;
    while (end > start && /[\s.,;:!?]/.test(text[end - 1]!)) end -= 1;
    const first = text[start];
    const last = text[end - 1];
    const quotes = first === "'" || first === '"' || first?.charCodeAt(0) === 96;
    if ((quotes && first === last) || (first === "(" && last === ")")) {
      start += 1;
      end -= 1;
    } else break;
  }
  return text.slice(start, end);
}

interface LabelledValue {
  start: number;
  end: number;
  value: string;
  tier: "password" | "credential";
  copula: boolean;
  comparison: boolean;
  quoted: boolean;
  openQuote: number | null;
  mode: LabelValueMode;
}

type QuoteMayClose = (openIndex: number, closeIndex: number) => boolean;
type LiteralDelimiter = (index: number) => boolean;
type LabelValueMode = "label" | "shell" | "query" | "table";

interface LabelOperator {
  end: number;
  comparison: boolean;
  copula: boolean;
  mode: LabelValueMode;
}

interface LocalCredentialValue {
  start: number;
  end: number;
  next: number;
  quoted: boolean;
  closed: boolean;
  value: string;
  openQuote: number | null;
}

const LABEL_PREFIX_WINDOW = 1_024;
const LABEL_CANDIDATE = /[:=?!+|>\-(,]|\b(?:is|was|are|were)\b/gi;
const LABEL_OPERATORS = new Set([
  ":",
  "=",
  ":=",
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
]);
const LABEL_COMPARISONS = new Set(["==", "===", "!=", "!=="]);
const NON_CREDENTIAL_KEY_WORD =
  /\b(?:storage|idempotency|cache|primary|foreign|public|sort|partition)\b/i;
const VALUE_GROUP_OPENING = new Map([
  ["\u0029", "("],
  ["]", "["],
  ["}", "{"],
]);

function labelWords(label: string): string[] {
  return (
    label
      .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\bAPIKEY(S?)\b/gi, "API KEY$1")
      .toLowerCase()
      .match(/[a-z]+|\d+/g) ?? []
  );
}

function credentialWordsWithoutEnvironmentSuffix(words: string[]): string[] {
  return /^(?:prod|production|dev|development|staging|test|local|base)$/.test(words.at(-1) ?? "")
    ? words.slice(0, -1)
    : words;
}

function isPasswordLabel(words: string[], fieldPosition: boolean): boolean {
  const compact = credentialWordsWithoutEnvironmentSuffix(words).join("");
  if (/(?:password|passwd|passphrase|passcode|pwd)\d*$/.test(compact)) return true;
  if (
    /^(?:login|security|admin|user|account|device|auth|authentication|access|customer|bank|card|atm|sim)pin\d*$/.test(
      compact,
    )
  )
    return true;
  if (/^pin(?:code|number)$/.test(compact)) return true;
  if (compact === "pass") return fieldPosition;
  return /^(?:db|database|login|admin|root|user|account|auth|sql|mysql|postgres|smtp|redis|service|app|client|server)pass\d*$/.test(
    compact,
  );
}

function isCredentialKeyLabel(words: string[]): boolean {
  const joined = credentialWordsWithoutEnvironmentSuffix(words).join(" ");
  const compact = joined.replaceAll(" ", "");
  if (/(?:service|storage)accountkey$/.test(compact)) return true;
  if (NON_CREDENTIAL_KEY_WORD.test(joined)) return false;
  return /(?:api|secret|access|private|hmac|signing|encryption|ssh|aws|google|gcp|azure|github|gitlab|stripe|openai|anthropic|resend|sendgrid|sentry|slack|npm|docker|cloudflare|supabase|firebase|database|db|oauth|auth|jwt|session|webhook|relay)key$/.test(
    compact,
  );
}

function credentialTier(label: string, fieldPosition: boolean): LabelledValue["tier"] | null {
  const words = labelWords(label);
  const compact = words.join("");
  if (/^(?:cookie|setcookie|authorization)$/.test(compact)) return null;
  if (isPasswordLabel(words, fieldPosition)) return "password";
  if (/(?:tokens?|secrets?|credentials?)\d*$/.test(compact)) return "credential";
  const ending = words.at(-1) ?? "";
  if (/^(?:jwt|auth|dsn)$/.test(ending) || (words.length > 1 && ending === "cookie"))
    return "credential";
  return isCredentialKeyLabel(words) ? "credential" : null;
}

function labelPrefix(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - LABEL_PREFIX_WINDOW), index);
  return prefix.slice(Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) + 1);
}

function stripLabelClosers(prefix: string): string {
  return prefix
    .replace(/<[^>\r\n]{0,128}>/g, "")
    .replace(/\[\d*\]\s*$/, "")
    .replace(/[\s\]\\"'`’”*_]+$/, "");
}

function quickCredentialLabel(text: string, index: number): boolean {
  let end = index;
  const floor = Math.max(0, index - LABEL_PREFIX_WINDOW);
  while (end > floor && /[\s\]\\"'`’”*_]/.test(text[end - 1]!)) end -= 1;
  if (/[\d[]/.test(text[end - 1] ?? "")) {
    const indexed = /\[\d*\][\s"'`’”*_]*$/.exec(text.slice(floor, index));
    if (indexed) end = floor + indexed.index;
  }
  let start = end;
  while (start > floor && /[A-Za-z0-9_$.-]/.test(text[start - 1]!)) start -= 1;
  const identifier = text.slice(start, end);
  if (
    /^(?:cookie|set[-_]?cookie|authorization|secret[-_]?name|credentials?[-_]?file|secretary)$/i.test(
      identifier,
    )
  )
    return false;
  return /password|passwd|passphrase|passcode|pwd|pass|pin|token|secret|credential|key|cookie|auth|dsn|jwt/i.test(
    identifier,
  );
}

function labelTierAt(text: string, index: number, copula: boolean): LabelledValue["tier"] | null {
  if (!copula && !quickCredentialLabel(text, index)) return null;
  let prefix = stripLabelClosers(labelPrefix(text, index));
  if (copula) prefix = prefix.replace(/\s+for\s+[^:;=]{1,256}$/i, "");
  const last = /[A-Za-z_$][A-Za-z0-9_$.-]*$/.exec(prefix);
  if (!last) return null;
  const before = prefix.slice(0, last.index);
  const fieldPosition =
    /^\s*$/.test(before) ||
    /[{'"`$;:(]\s*$/.test(before) ||
    /(?:^|[;{}])\s*(?:export\s+)?(?:(?:const|let|var)\s+)?$/.test(before) ||
    /\b(?:user(?:name)?|login|db|database|auth|credentials?)\b/i.test(before.slice(-128));
  const tier = credentialTier(last[0], fieldPosition);
  if (tier) return tier;
  // Spaced compound labels are read locally; prose before a bare pass/PIN is not a qualifier.
  const phrase = /([A-Za-z]+(?:\s+[A-Za-z]+){0,4})$/.exec(prefix)?.[0] ?? "";
  if (/\b(?:key|token|secret|credential|credentials)$/i.test(phrase))
    return credentialTier(phrase, false);
  if (/\b(?:login|security|admin|user|account|device|auth)\s+pin$/i.test(phrase)) return "password";
  if (/\b(?:db|login|admin|user|account|auth|sql|mysql|postgres)\s+pass$/i.test(phrase))
    return "password";
  return null;
}

function symbolicOperator(text: string, index: number): LabelOperator | null {
  let symbols = "";
  let cursor = index;
  let result: LabelOperator | null = null;
  for (let count = 0; count < 3; count += 1) {
    if (count > 0) while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    const character = text[cursor] ?? "";
    if (!/[:=?!+|>-]/.test(character)) break;
    symbols += character;
    cursor += 1;
    if (LABEL_OPERATORS.has(symbols)) {
      result = {
        end: cursor,
        comparison: LABEL_COMPARISONS.has(symbols),
        copula: false,
        mode:
          symbols === "=" && !/\s/.test(text[index - 1] ?? "") && !/\s/.test(text[cursor] ?? "")
            ? "shell"
            : "label",
      };
    }
  }
  return result;
}

function operatorAt(text: string, index: number, token: string): LabelOperator | null {
  if (/^(?:is|was|are|were)$/i.test(token)) {
    let end = index + token.length;
    while (text[end] === " " || text[end] === "\t") end += 1;
    if (text[end] === ":") end += 1;
    return { end, comparison: false, copula: true, mode: "label" };
  }
  if (token === "(") {
    const identifier = /([A-Za-z_$][\w$]*)\s*$/.exec(labelPrefix(text, index))?.[1] ?? "";
    if (labelWords(identifier)[0] !== "set") return null;
    return { end: index + 1, comparison: false, copula: false, mode: "label" };
  }
  if (token === ",") {
    const prefix = labelPrefix(text, index);
    const define = /\bdefine\s*\(\s*\\*["'`“‘][^\r\n]{1,512}["'`”’]\\*\s*$/i.test(prefix);
    const tuple = /(?:^|[^A-Za-z0-9_$])[[(]\s*\\*["'`“‘][^"'`“”‘’\r\n]{1,512}["'`”’]\\*\s*$/.test(
      prefix,
    );
    if (!define && !tuple) return null;
    return { end: index + 1, comparison: false, copula: false, mode: "label" };
  }
  const symbolic = symbolicOperator(text, index);
  if (symbolic) return symbolic;
  if (token === "|" && labelPrefix(text, index).includes("|")) {
    return { end: index + 1, comparison: false, copula: false, mode: "table" };
  }
  return null;
}

function skipValuePrefix(
  text: string,
  index: number,
  isLiteralDelimiter: LiteralDelimiter,
): number {
  let cursor = index;
  while (cursor < text.length && isLiteralDelimiter(cursor) && /\s/.test(text[cursor]!))
    cursor += 1;
  return cursor;
}

function closingQuote(opening: string): string | null {
  if (opening === '"' || opening === "'" || opening === "`") return opening;
  if (opening === "“") return "”";
  if (opening === "‘") return "’";
  return null;
}

function slashRunEnd(
  text: string,
  index: number,
  isLiteralDelimiter: LiteralDelimiter = () => true,
): number {
  let cursor = index;
  while (text[cursor] === "\\" && isLiteralDelimiter(cursor)) cursor += 1;
  return cursor;
}

function unquotedTerminator(text: string, index: number, mode: LabelValueMode): boolean {
  const character = text[index]!;
  if (/\s/.test(character)) return true;
  if (mode === "query") return /[&#]/.test(character);
  if (mode === "table") return character === "|";
  return (
    mode === "shell" && (character === ";" || character === "|" || text.startsWith("&&", index))
  );
}

function consumeValueGroup(character: string, groups: string[], balanced: boolean): boolean {
  if (balanced && /[([{]/.test(character)) groups.push(character);
  const opening = VALUE_GROUP_OPENING.get(character);
  if (opening === undefined) return true;
  if (groups.at(-1) !== opening) return false;
  groups.pop();
  return true;
}

function isOutsideValueQuote(text: string, index: number): boolean {
  const next = text[index + 1];
  return next === undefined || /[\s),;\]}|&]/.test(next);
}

function unquotedEnd(
  text: string,
  start: number,
  mode: LabelValueMode,
  quoteMayClose: QuoteMayClose,
  isLiteralDelimiter: LiteralDelimiter,
  balanced = true,
): number {
  let end = start;
  const groups: string[] = [];
  while (end < text.length) {
    const character = text[end]!;
    if (!isLiteralDelimiter(end)) {
      end += 1;
      continue;
    }
    const grouped = groups.length > 0;
    if (unquotedTerminator(text, end, mode)) break;
    if (/["'`“”‘’]/.test(character)) {
      if (!grouped) {
        if (isOutsideValueQuote(text, end)) break;
        end += 1;
        continue;
      }
      if (!closingQuote(character)) break;
      const quote = quotedEnd(text, end, 0, quoteMayClose, isLiteralDelimiter);
      if (!quote) break;
      end = quote.next;
      continue;
    }
    if (character === "\\") {
      const slashEnd = slashRunEnd(text, end, isLiteralDelimiter);
      if (/[nrt]/.test(text[slashEnd] ?? "")) break;
      if (/["'`“”‘’]/.test(text[slashEnd] ?? "") && isOutsideValueQuote(text, slashEnd)) break;
      end = slashEnd;
      continue;
    }
    if (!consumeValueGroup(character, groups, balanced)) break;
    end += 1;
  }
  while (end > start && isLiteralDelimiter(end - 1) && /[,;]/.test(text[end - 1]!)) end -= 1;
  return end;
}

function quotedEnd(
  text: string,
  opening: number,
  openingDepth: number,
  quoteMayClose: QuoteMayClose,
  isLiteralDelimiter: LiteralDelimiter,
): { end: number; next: number } | null {
  const close = closingQuote(text[opening] ?? "");
  if (!close) return null;
  const start = opening + 1;
  let cursor = start;
  while (cursor < text.length) {
    if (isLiteralDelimiter(cursor) && /[\n\r]/.test(text[cursor]!)) break;
    if (text[cursor] === "\\" && isLiteralDelimiter(cursor)) {
      const slashEnd = slashRunEnd(text, cursor, isLiteralDelimiter);
      const depth = slashEnd - cursor;
      const sameEscapeDepth =
        depth >= openingDepth && (depth - openingDepth) % (2 * (openingDepth + 1)) === 0;
      if (text[slashEnd] === close && sameEscapeDepth && quoteMayClose(opening, slashEnd)) {
        return { end: slashEnd - openingDepth, next: slashEnd + 1 };
      }
      cursor = Math.min(text.length, slashEnd + 1);
      continue;
    }
    if (text[cursor] === close && openingDepth === 0 && quoteMayClose(opening, cursor)) {
      return { end: cursor, next: cursor + 1 };
    }
    cursor += 1;
  }
  return null;
}

/** Starts before the optional value-opening quote; offsets refer to the original input. */
function readLocalCredentialValue(
  text: string,
  index: number,
  quoteMayClose: QuoteMayClose = () => true,
  mode: LabelValueMode = "label",
  isLiteralDelimiter: LiteralDelimiter = () => true,
): LocalCredentialValue {
  index = skipValuePrefix(text, index, isLiteralDelimiter);
  const placeholderEnd = closedAnglePlaceholderEnd(text, index, isLiteralDelimiter);
  if (placeholderEnd !== null)
    return {
      start: index,
      end: placeholderEnd,
      next: placeholderEnd,
      value: text.slice(index, placeholderEnd),
      quoted: false,
      closed: true,
      openQuote: null,
    };
  const opening = slashRunEnd(text, index, isLiteralDelimiter);
  const openingDepth = opening - index;
  const quoted = closingQuote(text[opening] ?? "") !== null;
  const start = quoted ? opening + 1 : index;
  const quote = quoted
    ? quotedEnd(text, opening, openingDepth, quoteMayClose, isLiteralDelimiter)
    : null;
  const end =
    quote?.end ?? unquotedEnd(text, start, mode, quoteMayClose, isLiteralDelimiter, !quoted);
  return {
    start,
    end,
    next: quote?.next ?? end,
    quoted,
    closed: quote !== null,
    value: text.slice(start, end),
    openQuote: quoted ? opening : null,
  };
}

function closedAnglePlaceholderEnd(
  text: string,
  index: number,
  isLiteralDelimiter: LiteralDelimiter,
): number | null {
  if (text[index] !== "<" || !isLiteralDelimiter(index)) return null;
  let end = index + 1;
  while (end < text.length) {
    if (isLiteralDelimiter(end)) {
      if (text[end] === ">") return end + 1;
      if (/[<\n\r]/.test(text[end]!)) return null;
    }
    end += 1;
  }
  return null;
}

function valueModeAt(text: string, operatorIndex: number, mode: LabelValueMode): LabelValueMode {
  if (mode !== "shell") return mode;
  const prefix = labelPrefix(text, operatorIndex);
  if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*$/.test(prefix)) return "label";
  return /(?:^|[^&])[?&#][^\s?&#=]*$/.test(prefix) ? "query" : mode;
}

function quotedLabelClosingAt(
  text: string,
  operatorIndex: number,
  operatorEnd: number,
  quoteMayClose: QuoteMayClose,
): number | null {
  const prefixStart = Math.max(0, operatorIndex - LABEL_PREFIX_WINDOW);
  const prefix = text.slice(prefixStart, operatorIndex);
  const label = /(?:^|[^A-Za-z0-9])(["'`“‘])[*_]*[A-Za-z_$][A-Za-z0-9_$ .-]{0,256}$/.exec(prefix);
  if (!label) return null;
  const opening = prefixStart + label.index + label[0].indexOf(label[1]!);
  const closing = operatorEnd;
  return text[closing] === closingQuote(label[1]!) && quoteMayClose(opening, closing)
    ? closing
    : null;
}

/** Reads local labelled values only. Policy and redaction remain at the caller. */
function labelledValues(
  text: string,
  quoteMayClose: QuoteMayClose = () => true,
  isLiteralDelimiter: LiteralDelimiter = () => true,
): LabelledValue[] {
  const values: LabelledValue[] = [];
  const scanner = new RegExp(LABEL_CANDIDATE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const copula = /^(?:is|was|are|were)$/i.test(match[0]);
    const operator = operatorAt(text, match.index, match[0]);
    if (!operator) continue;
    const tier = labelTierAt(text, match.index, copula);
    if (!tier) continue;
    scanner.lastIndex = operator.end;
    if (operator.comparison && tier !== "password") continue;
    const labelClosing = quotedLabelClosingAt(text, match.index, operator.end, quoteMayClose);
    if (labelClosing !== null) {
      scanner.lastIndex = labelClosing + 1;
      continue;
    }
    let index = operator.end;
    // Markdown delimiters that close a colon-bearing label belong to the label.
    if (/[*_]/.test(text[index] ?? "") && /[*_]/.test(labelPrefix(text, match.index))) {
      while (text[index] === "*" || text[index] === "_") index += 1;
    }
    index = skipValuePrefix(text, index, isLiteralDelimiter);
    const mode = valueModeAt(text, match.index, operator.mode);
    const value = readLocalCredentialValue(text, index, quoteMayClose, mode, isLiteralDelimiter);
    if (value.end <= value.start || (operator.comparison && (!value.quoted || !value.closed)))
      continue;
    values.push({
      start: value.start,
      end: value.end,
      value: value.value,
      tier,
      copula: operator.copula,
      comparison: operator.comparison,
      quoted: value.quoted,
      openQuote: value.openQuote,
      mode,
    });
    scanner.lastIndex = Math.max(scanner.lastIndex, value.next);
  }
  return values;
}

type CredentialWordName = (name: string) => boolean;

interface Token {
  kind: "word" | "number" | "string" | "punct" | "end";
  text: string;
  start: number;
  end: number;
}

function defaultWordName(name: string): boolean {
  return (
    /^[A-Za-z_$]+$/.test(name) ||
    ((/\d+[A-Za-z]/.test(name) || /[a-z][A-Z]/.test(name)) && isWordlikeIdentifier(name))
  );
}

function quotedTokenEnd(text: string, start: number): { end: number; closed: boolean } {
  const quote = text[start];
  let end = start + 1;
  while (end < text.length) {
    if (text[end] === "\\") end += 2;
    else if (text[end] === quote) return { end: end + 1, closed: true };
    else if (text[end] === "\n" || text[end] === "\r") break;
    else end += 1;
  }
  return { end, closed: false };
}

class CredentialLexer {
  position: number;
  readonly text: string;
  private cached: Token | null = null;
  constructor(text: string, start: number) {
    this.text = text;
    this.position = start;
  }
  reset(position: number): void {
    this.position = position;
    this.cached = null;
  }
  peek(): Token {
    if (this.cached) return this.cached;
    let start = this.position;
    while (/\s/.test(this.text[start] ?? "") && start < this.text.length) start += 1;
    if (start === this.text.length)
      return (this.cached = { kind: "end", text: "", start, end: start });
    const character = this.text[start]!;
    let end = start + 1;
    let kind: Token["kind"] = "punct";
    if (
      /[A-Za-z_$]/.test(character) &&
      !this.text.startsWith("${", start) &&
      !this.text.startsWith("$(", start)
    ) {
      kind = "word";
      while (/[A-Za-z0-9_$]/.test(this.text[end] ?? "")) end += 1;
    } else if (/\d/.test(character)) {
      kind = "number";
      const number =
        /(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)(?:n)?/y;
      number.lastIndex = start;
      end = start + (number.exec(this.text)?.[0].length ?? 1);
    } else if (character === "'" || character === '"') {
      const quoted = quotedTokenEnd(this.text, start);
      end = quoted.end;
      kind = quoted.closed ? "string" : "punct";
    } else {
      for (const operator of [
        "===",
        "!==",
        "...",
        "**",
        "?.",
        "&&",
        "||",
        "??",
        "=>",
        "==",
        "!=",
        "${",
        "$(",
      ]) {
        if (this.text.startsWith(operator, start)) {
          end = start + operator.length;
          break;
        }
      }
    }
    return (this.cached = { kind, text: this.text.slice(start, end), start, end });
  }
  take(): Token {
    const token = this.peek();
    this.position = token.end;
    this.cached = null;
    return token;
  }
}

interface ExpressionNode {
  depends: boolean;
  structured: boolean;
  bare: boolean;
  word: boolean;
  end: number;
  parameters?: boolean;
  container?: boolean;
}

interface ExpressionOperator {
  name: string;
  precedence: number;
  unary?: boolean;
}

interface ExpressionFrame {
  kind: "root" | "group" | "array" | "object" | "index" | "call" | "interpolation";
  close: string;
  values: ExpressionNode[];
  operators: ExpressionOperator[];
  elements: ExpressionNode[];
  operand: boolean;
  owner?: ExpressionNode;
  codeContext: boolean;
  arrowContext: boolean;
  arrowBody: boolean;
}

interface TemplateFrame {
  kind: "template";
  implicit: boolean;
  depends: boolean;
  expansion: boolean;
  end: number;
}

type ParseFrame = ExpressionFrame | TemplateFrame;

function expressionFrame(
  kind: ExpressionFrame["kind"],
  close = "",
  owner?: ExpressionNode,
  parent?: ExpressionFrame,
): ExpressionFrame {
  return {
    kind,
    close,
    owner,
    values: [],
    operators: [],
    elements: [],
    operand: true,
    codeContext: kind === "call" || !!parent?.codeContext,
    arrowContext: !!parent?.arrowContext || !!parent?.arrowBody,
    arrowBody: false,
  };
}

function reduceExpression(frame: ExpressionFrame): boolean {
  const operator = frame.operators.pop();
  if (!operator || operator.name === "?") return false;
  const right = frame.values.pop();
  if (!right) return false;
  if (operator.unary) {
    frame.values.push({ ...right, structured: true, bare: false });
    return true;
  }
  const middle = operator.name === "?:" ? frame.values.pop() : undefined;
  const left = frame.values.pop();
  if (!left || (operator.name === "?:" && !middle)) return false;
  frame.values.push({
    depends:
      operator.name === "=>" ? right.depends : left.depends || right.depends || !!middle?.depends,
    structured: true,
    bare: false,
    word: true,
    end: right.end,
  });
  return true;
}

function finishExpression(frame: ExpressionFrame): ExpressionNode | null {
  if (frame.operand) return null;
  while (frame.operators.length > 0) if (!reduceExpression(frame)) return null;
  return frame.values.length === 1 ? frame.values[0]! : null;
}

function deliverExpression(frame: ExpressionFrame, node: ExpressionNode): void {
  frame.values.push(node);
  frame.operand = false;
}

/** Commands in $(...) use shell syntax rather than the expression grammar. */
function shellSubstitutionEnd(text: string, start: number): number | null {
  let depth = 1;
  let quote = "";
  for (let cursor = start + 2; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (character === "\\") cursor += 1;
    else if (quote) {
      if (character === quote) quote = "";
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return cursor > start + 2 ? cursor + 1 : null;
    }
  }
  return null;
}

/** Top-level formatting references; call arguments and quoted strings are excluded. */
function implicitTemplateStart(text: string, start: number, full: boolean): number | null {
  let words = 0;
  let inWord = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (character === "$" && (text[cursor + 1] === "{" || text[cursor + 1] === "(")) return cursor;
    if (/[()[\]'"`;|&<>\r\n]/.test(character)) return null;
    if (/\s/.test(character)) {
      if (inWord) words += 1;
      inWord = false;
      if (!full && words > 1) return null;
    } else inWord = true;
  }
  return null;
}

interface ExpressionState {
  text: string;
  full: boolean;
  wordName: CredentialWordName;
  lexer: CredentialLexer;
  stack: ParseFrame[];
  lastEnd: number;
}

type ExpressionStep = ExpressionNode | null | undefined;

function templateBoundary(top: TemplateFrame, character: string, full: boolean): boolean {
  if (!top.implicit) return character === "`";
  if (/[;'"`,|&<>\r\n]/.test(character)) return true;
  return !full && /\s/.test(character);
}

function readTemplateChunk(
  state: ExpressionState,
  top: TemplateFrame,
): "nested" | "closed" | "invalid" {
  let cursor = state.lexer.position;
  while (cursor < state.text.length) {
    const character = state.text[cursor]!;
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "$" && state.text[cursor + 1] === "(") {
      const end = shellSubstitutionEnd(state.text, cursor);
      if (end === null) return "invalid";
      top.depends = true;
      top.expansion = true;
      cursor = end;
      top.end = end;
      continue;
    }
    if (character === "$" && state.text[cursor + 1] === "{") {
      top.expansion = true;
      state.lexer.reset(cursor + 2);
      state.stack.push(expressionFrame("interpolation", "}"));
      return "nested";
    }
    if (templateBoundary(top, character, state.full)) break;
    cursor += 1;
    top.end = cursor;
  }
  state.lexer.reset(cursor);
  return "closed";
}

function stepTemplate(state: ExpressionState, top: TemplateFrame): ExpressionStep {
  const chunk = readTemplateChunk(state, top);
  if (chunk === "invalid") return null;
  if (chunk === "nested") return undefined;
  const cursor = state.lexer.position;
  if (!top.implicit && state.text[cursor] !== "`") return null;
  const end = top.implicit ? cursor : cursor + 1;
  const node: ExpressionNode = {
    depends: top.depends,
    structured: top.expansion,
    bare: false,
    word: true,
    end,
  };
  state.stack.pop();
  state.lexer.reset(end);
  if (state.stack.length === 0) return node;
  const parent = state.stack[state.stack.length - 1]!;
  if (parent.kind === "template") return null;
  deliverExpression(parent, node);
  state.lastEnd = end;
  return undefined;
}

function closedExpressionNode(
  state: ExpressionState,
  top: ExpressionFrame,
  elements: ExpressionNode[],
  current: ExpressionNode | null,
  end: number,
): ExpressionNode | null {
  const references = elements.some((element) => element.depends);
  const normal: ExpressionNode = {
    depends: references,
    structured: true,
    bare: false,
    word: true,
    end,
  };
  if (top.kind === "call") {
    if (elements.length > 0) return normal;
    const owner = top.owner!;
    return { ...normal, depends: owner.bare ? owner.word : owner.depends };
  }
  if (top.kind === "index")
    return elements.length === 0 ? null : { ...normal, depends: top.owner!.depends || references };
  if (top.kind === "array" || top.kind === "object") return { ...normal, container: true };
  if (top.kind === "interpolation")
    return current ? { ...current, structured: true, bare: false, end } : null;
  const last = elements[elements.length - 1];
  if (last) return { ...last, end, parameters: true };
  if (state.lexer.peek().text !== "=>") return null;
  return { depends: false, structured: false, bare: false, word: true, end, parameters: true };
}

function stepExpressionClose(
  state: ExpressionState,
  top: ExpressionFrame,
  token: Token,
): ExpressionStep {
  const current =
    top.operand && top.values.length === 0 && top.elements.length === 0
      ? null
      : finishExpression(top);
  const empty = top.operand && top.values.length === 0 && top.operators.length === 0;
  if (!current && !empty) return null;
  const elements = current ? [...top.elements, current] : top.elements;
  state.lexer.take();
  const node = closedExpressionNode(state, top, elements, current, token.end);
  if (!node) return null;
  state.stack.pop();
  const parent = state.stack[state.stack.length - 1];
  if (!parent) return null;
  if (parent.kind === "template") {
    parent.depends ||= node.depends;
    parent.end = token.end;
  } else deliverExpression(parent, node);
  state.lastEnd = token.end;
  return undefined;
}

function pushExpressionAccess(
  state: ExpressionState,
  top: ExpressionFrame,
  owner: ExpressionNode,
  opening: string,
): ExpressionStep {
  if (!owner.word) return null;
  state.lexer.take();
  top.values.pop();
  state.stack.push(
    expressionFrame(opening === "(" ? "call" : "index", opening === "(" ? ")" : "]", owner, top),
  );
  return undefined;
}

function stepGenericExpression(
  state: ExpressionState,
  top: ExpressionFrame,
  owner: ExpressionNode,
  token: Token,
): ExpressionStep {
  if (!owner.word) return null;
  const argumentsNode = parseCredentialType(state.text, token.start, state.wordName, true);
  if (!argumentsNode?.valid) return null;
  state.lexer.reset(argumentsNode.end);
  if (state.lexer.peek().text !== "(") return null;
  return pushExpressionAccess(state, top, owner, "(");
}

function stepExpressionMember(
  state: ExpressionState,
  top: ExpressionFrame,
  owner: ExpressionNode,
  token: Token,
): ExpressionStep {
  state.lexer.take();
  const member = state.lexer.peek();
  if (token.text === "?." && (member.text === "(" || member.text === "["))
    return pushExpressionAccess(state, top, owner, member.text);
  if (member.kind !== "word" || !state.wordName(member.text) || !owner.word) return null;
  state.lexer.take();
  top.values[top.values.length - 1] = { ...owner, structured: true, bare: false, end: member.end };
  state.lastEnd = member.end;
  return undefined;
}

function stepExpressionComma(state: ExpressionState, top: ExpressionFrame): ExpressionStep {
  const element = finishExpression(top);
  if (!element) return null;
  top.elements.push(element);
  top.values = [];
  top.operators = [];
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function arrowAnnotationEnd(state: ExpressionState, start: number): number | null {
  const lexer = new CredentialLexer(state.text, start);
  const first = lexer.take();
  let typeStart = first.start;
  if (first.kind === "word" && state.wordName(first.text) && lexer.peek().text === "is") {
    lexer.take();
    typeStart = lexer.peek().start;
  }
  const type = parseCredentialType(state.text, typeStart, state.wordName, false, true);
  if (!type?.valid || !type.type) return null;
  lexer.reset(type.end);
  return lexer.peek().text === "=>" ? type.end : null;
}

function stepArrowAnnotation(state: ExpressionState, top: ExpressionFrame): boolean {
  const owner = top.values[top.values.length - 1];
  if (!owner?.parameters || top.operators.some((operator) => operator.name === "?")) return false;
  const end = arrowAnnotationEnd(state, state.lexer.peek().end);
  if (end === null) return false;
  state.lexer.reset(end);
  top.values[top.values.length - 1] = { ...owner, end };
  state.lastEnd = end;
  return true;
}

function stepExpressionColon(state: ExpressionState, top: ExpressionFrame): ExpressionStep {
  if (stepArrowAnnotation(state, top)) return undefined;
  if (top.kind === "object" && top.values.length === 1 && top.operators.length === 0) {
    top.values.pop();
  } else {
    while (top.operators.length && top.operators[top.operators.length - 1]!.name !== "?") {
      if (!reduceExpression(top)) return null;
    }
    if (top.operators.pop()?.name !== "?") return null;
    top.operators.push({ name: "?:", precedence: 1 });
  }
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function expressionPrecedence(operator: string): number {
  switch (operator) {
    case "=>":
      return 0;
    case "?":
      return 1;
    case "||":
    case "??":
      return 2;
    case "&&":
      return 3;
    case "==":
    case "===":
    case "!=":
    case "!==":
      return 4;
    case "+":
    case "-":
      return 5;
    case "*":
    case "/":
    case "%":
      return 6;
    case "**":
      return 7;
    default:
      return -1;
  }
}

function stepExpressionOperator(
  state: ExpressionState,
  top: ExpressionFrame,
  owner: ExpressionNode,
  token: Token,
  precedence: number,
): ExpressionStep {
  if (precedence >= 5 && !top.codeContext) return null;
  if (
    precedence === 4 &&
    !owner.structured &&
    !top.arrowContext &&
    !top.arrowBody &&
    !top.operators.some((operator) => operator.unary)
  )
    return null;
  if (token.text === "=>" && !(owner.parameters || owner.bare)) return null;
  while (
    top.operators.length &&
    top.operators[top.operators.length - 1]!.name !== "?" &&
    top.operators[top.operators.length - 1]!.precedence >= precedence
  ) {
    if (!reduceExpression(top)) return null;
  }
  top.operators.push({ name: token.text, precedence });
  if (token.text === "=>") top.arrowBody = true;
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function rootExpressionBoundary(
  state: ExpressionState,
  top: ExpressionFrame,
  token: Token,
): boolean {
  return (
    top.kind === "root" &&
    state.stack.length === 1 &&
    (token.start > state.lastEnd || /^[,;)}\]]$/.test(token.text))
  );
}

function stepExpressionPostfix(
  state: ExpressionState,
  top: ExpressionFrame,
  token: Token,
): ExpressionStep {
  const owner = top.values[top.values.length - 1]!;
  if (token.text === "<") return stepGenericExpression(state, top, owner, token);
  if (token.text === "." || token.text === "?.")
    return stepExpressionMember(state, top, owner, token);
  if (token.text === "(" || token.text === "[")
    return pushExpressionAccess(state, top, owner, token.text);
  if (token.text === "!") {
    state.lexer.take();
    top.values[top.values.length - 1] = { ...owner, structured: true, end: token.end };
    state.lastEnd = token.end;
    return undefined;
  }
  if (token.text === "," && top.kind !== "root") return stepExpressionComma(state, top);
  if (token.text === ":") return stepExpressionColon(state, top);
  const precedence = expressionPrecedence(token.text);
  if (precedence >= 0) return stepExpressionOperator(state, top, owner, token, precedence);
  return rootExpressionBoundary(state, top, token) ? finishExpression(top) : null;
}

function openingExpression(token: string): [ExpressionFrame["kind"], string] | null {
  switch (token) {
    case "(":
      return ["group", ")"];
    case "[":
      return ["array", "]"];
    case "{":
      return ["object", "}"];
    default:
      return null;
  }
}

function expressionPrefix(token: Token): boolean {
  return (
    token.text === "!" ||
    token.text === "..." ||
    (token.kind === "word" && /^(?:typeof|new|await|readonly)$/.test(token.text))
  );
}

function expressionLiteral(token: Token): boolean {
  return (
    token.kind === "string" ||
    token.kind === "number" ||
    (token.kind === "word" && /^(?:true|false|null|undefined)$/.test(token.text))
  );
}

/** Closed environment-reference syntax is independent of identifier shape. */
function environmentReferenceEnd(text: string, start: number): number | null {
  if (text[start] !== "$" && text[start] !== "%") return null;
  const reference =
    /(?:%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*)/iy;
  reference.lastIndex = start;
  return reference.exec(text)?.[0].length ? reference.lastIndex : null;
}

function stepExpressionPrimary(
  state: ExpressionState,
  top: ExpressionFrame,
  token: Token,
): ExpressionStep {
  if (expressionPrefix(token)) {
    top.operators.push({ name: token.text, precedence: 9, unary: true });
    state.lexer.take();
    return undefined;
  }
  if (token.text === "`") {
    state.lexer.take();
    state.stack.push({
      kind: "template",
      implicit: false,
      depends: false,
      expansion: false,
      end: token.end,
    });
    return undefined;
  }
  if (token.text === "${") {
    state.lexer.take();
    state.stack.push(expressionFrame("interpolation", "}", undefined, top));
    return undefined;
  }
  if (token.text === "$(") {
    const end = shellSubstitutionEnd(state.text, token.start);
    if (end === null) return null;
    state.lexer.reset(end);
    deliverExpression(top, { depends: true, structured: true, bare: false, word: true, end });
    state.lastEnd = end;
    return undefined;
  }
  const environmentEnd = environmentReferenceEnd(state.text, token.start);
  if (environmentEnd !== null) {
    state.lexer.reset(environmentEnd);
    deliverExpression(top, {
      depends: true,
      structured: true,
      bare: false,
      word: true,
      end: environmentEnd,
    });
    state.lastEnd = environmentEnd;
    return undefined;
  }
  const opening = openingExpression(token.text);
  if (opening) {
    state.lexer.take();
    state.stack.push(expressionFrame(opening[0], opening[1], undefined, top));
    return undefined;
  }
  if (expressionLiteral(token)) {
    state.lexer.take();
    deliverExpression(top, {
      depends: false,
      structured: false,
      bare: false,
      word: false,
      end: token.end,
    });
  } else if (token.kind === "word") {
    state.lexer.take();
    const valid = state.wordName(token.text);
    deliverExpression(top, {
      depends: valid,
      structured: false,
      bare: true,
      word: valid,
      end: token.end,
    });
  } else return null;
  state.lastEnd = token.end;
  return undefined;
}

function advanceExpression(state: ExpressionState): ExpressionStep {
  const top = state.stack[state.stack.length - 1]!;
  if (top.kind === "template") return stepTemplate(state, top);
  const token = state.lexer.peek();
  if (top.close && token.text === top.close) return stepExpressionClose(state, top, token);
  if (token.kind === "end")
    return top.kind === "root" && state.stack.length === 1 ? finishExpression(top) : null;
  return top.operand
    ? stepExpressionPrimary(state, top, token)
    : stepExpressionPostfix(state, top, token);
}

function parseCredentialExpression(
  text: string,
  start: number,
  full: boolean,
  wordName: CredentialWordName,
): ExpressionNode | null {
  const lexer = new CredentialLexer(text, start);
  const implicit = implicitTemplateStart(text, start, full);
  const stack: ParseFrame[] =
    implicit === null
      ? [expressionFrame("root")]
      : [{ kind: "template", implicit: true, depends: false, expansion: false, end: implicit }];
  if (implicit !== null) lexer.reset(implicit);
  const state: ExpressionState = { text, full, wordName, lexer, stack, lastEnd: start };
  while (state.stack.length > 0) {
    const result = advanceExpression(state);
    if (result !== undefined) return result;
  }
  return null;
}

function readCredentialExpressionEnd(
  text: string,
  start: number,
  wordName: CredentialWordName = defaultWordName,
): number | null {
  const node = parseCredentialExpression(text, start, false, wordName);
  return node?.structured && (node.depends || node.container) ? node.end : null;
}

function isCredentialExpression(
  value: string,
  wordName: CredentialWordName = defaultWordName,
): boolean {
  const text = value.trim();
  const node = parseCredentialExpression(text, 0, true, wordName);
  return !!node?.structured && (node.depends || !!node.container) && node.end === text.length;
}

interface CredentialTypeNode {
  valid: boolean;
  type: boolean;
  end: number;
  name?: string;
  parameters?: boolean;
}

interface CredentialTypeFrame {
  kind: "root" | "group" | "tuple" | "arguments";
  close: string;
  owner?: CredentialTypeNode;
  values: CredentialTypeNode[];
  operators: string[];
  elements: CredentialTypeNode[];
  operand: boolean;
  parameter: boolean;
}

function typeFrame(
  kind: CredentialTypeFrame["kind"],
  close = "",
  owner?: CredentialTypeNode,
): CredentialTypeFrame {
  return {
    kind,
    close,
    owner,
    values: [],
    operators: [],
    elements: [],
    operand: true,
    parameter: false,
  };
}

function credentialTypeName(name: string): boolean {
  return (
    /^(?:string|number|boolean|bigint|symbol|unknown|never|object|any|void|undefined|null|str|bytes|byte|bool|char|list|dict|set|tuple|[ui](?:8|16|32|64|128|size)|f(?:32|64))$/.test(
      name,
    ) ||
    /^[A-Z][A-Za-z]*$/.test(name) ||
    (name.length < 16 &&
      /^(?:(?:Uint|Int)(?:8|16|32)|Big(?:Uint|Int)64|Float(?:32|64))Array$/.test(name))
  );
}

function reduceType(frame: CredentialTypeFrame): boolean {
  const operator = frame.operators.pop();
  const right = frame.values.pop();
  const left = frame.values.pop();
  if (!operator || !right || !left) return false;
  if (operator === "=>") {
    if (!left.parameters || !right.type) return false;
  } else if (!left.valid || !right.valid) return false;
  frame.values.push({ valid: true, type: true, end: right.end });
  return true;
}

function finishType(frame: CredentialTypeFrame): CredentialTypeNode | null {
  if (frame.operand) return null;
  while (frame.operators.length) if (!reduceType(frame)) return null;
  return frame.values.length === 1 ? frame.values[0]! : null;
}

function deliverType(frame: CredentialTypeFrame, node: CredentialTypeNode): void {
  frame.values.push(node);
  frame.operand = false;
}

interface CredentialTypeState {
  text: string;
  wordName: CredentialWordName;
  lexer: CredentialLexer;
  stack: CredentialTypeFrame[];
  lastEnd: number;
  stopAtArrow: boolean;
}

type CredentialTypeStep = CredentialTypeNode | null | undefined;

function closedTypeNode(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  elements: CredentialTypeNode[],
  end: number,
): CredentialTypeNode {
  if (top.kind === "group") {
    const arrow = state.lexer.peek().text === "=>";
    const validParameters = elements.every(
      (element) => element.type || (!!element.name && state.wordName(element.name)),
    );
    return {
      valid: arrow ? validParameters : elements.length === 1 && elements[0]!.valid,
      type: !arrow && elements.length === 1 && elements[0]!.type,
      parameters: arrow && validParameters,
      end,
    };
  }
  if (top.kind === "tuple")
    return {
      valid: elements.every((element) => element.valid),
      type: elements.every((element) => element.type),
      end,
    };
  const valid =
    !!top.owner?.valid && elements.length > 0 && elements.every((element) => element.valid);
  return { valid, type: !!top.owner?.type && valid, end };
}

function stepTypeClose(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  token: Token,
): CredentialTypeStep {
  const current = top.operand && top.values.length === 0 ? null : finishType(top);
  const empty = top.operand && top.values.length === 0 && top.operators.length === 0;
  if (!current && !empty) return null;
  const elements = current ? [...top.elements, current] : top.elements;
  state.lexer.take();
  const node = closedTypeNode(state, top, elements, token.end);
  state.stack.pop();
  if (state.stack.length === 0) return node;
  deliverType(state.stack[state.stack.length - 1]!, node);
  state.lastEnd = token.end;
  return undefined;
}

function typeParameterPosition(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  owner: CredentialTypeNode,
  token: Token,
): boolean {
  return (
    token.text === ":" &&
    top.kind === "group" &&
    top.values.length === 1 &&
    top.operators.length === 0 &&
    !!owner.name &&
    state.wordName(owner.name)
  );
}

function stepTypeParameter(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
): CredentialTypeStep {
  top.values.pop();
  top.parameter = true;
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function stepTypeMember(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  owner: CredentialTypeNode,
): CredentialTypeStep {
  if (!owner.name || !state.wordName(owner.name)) return null;
  state.lexer.take();
  const member = state.lexer.take();
  if (member.kind !== "word" || !state.wordName(member.text)) return null;
  const valid = credentialTypeName(member.text);
  top.values[top.values.length - 1] = { valid, type: valid, name: member.text, end: member.end };
  state.lastEnd = member.end;
  return undefined;
}

function stepTypeArguments(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  owner: CredentialTypeNode,
  token: Token,
): CredentialTypeStep {
  if (!owner.type) return null;
  state.lexer.take();
  if (token.text === "[" && state.lexer.peek().text === "]") {
    const closing = state.lexer.take();
    top.values[top.values.length - 1] = { valid: true, type: true, end: closing.end };
    state.lastEnd = closing.end;
  } else {
    top.values.pop();
    state.stack.push(typeFrame("arguments", token.text === "<" ? ">" : "]", owner));
  }
  return undefined;
}

function stepTypeComma(state: CredentialTypeState, top: CredentialTypeFrame): CredentialTypeStep {
  const element = finishType(top);
  if (!element) return null;
  top.elements.push(element);
  top.values = [];
  top.operators = [];
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function stepTypeOperator(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  token: Token,
): CredentialTypeStep {
  while (top.operators.length && token.text !== "=>") {
    if (!reduceType(top)) return null;
  }
  top.operators.push(token.text);
  top.operand = true;
  state.lexer.take();
  return undefined;
}

function rootTypeBoundary(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  token: Token,
): boolean {
  return (
    top.kind === "root" &&
    state.stack.length === 1 &&
    (token.start > state.lastEnd || /^[,;)}\]]$/.test(token.text))
  );
}

function stepTypePostfix(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  token: Token,
): CredentialTypeStep {
  const owner = top.values[top.values.length - 1]!;
  if (state.stopAtArrow && top.kind === "root" && token.text === "=>") return finishType(top);
  if (typeParameterPosition(state, top, owner, token)) return stepTypeParameter(state, top);
  if (token.text === ".") return stepTypeMember(state, top, owner);
  if (token.text === "<" || token.text === "[") return stepTypeArguments(state, top, owner, token);
  if (token.text === "," && top.kind !== "root") return stepTypeComma(state, top);
  if (["|", "&", "=>"].includes(token.text)) return stepTypeOperator(state, top, token);
  return rootTypeBoundary(state, top, token) ? finishType(top) : null;
}

function stepTypeQuery(state: CredentialTypeState, top: CredentialTypeFrame): CredentialTypeStep {
  state.lexer.take();
  let name = state.lexer.take();
  if (name.kind !== "word" || !state.wordName(name.text)) return null;
  while (state.lexer.peek().text === ".") {
    state.lexer.take();
    name = state.lexer.take();
    if (name.kind !== "word" || !state.wordName(name.text)) return null;
  }
  deliverType(top, { valid: true, type: true, end: name.end });
  state.lastEnd = name.end;
  return undefined;
}

function stepTypePrimary(
  state: CredentialTypeState,
  top: CredentialTypeFrame,
  token: Token,
): CredentialTypeStep {
  if (token.text === "readonly") {
    state.lexer.take();
    return undefined;
  }
  if (token.text === "typeof") return stepTypeQuery(state, top);
  if (token.text === "(") {
    state.lexer.take();
    state.stack.push(typeFrame("group", ")"));
    return undefined;
  }
  if (token.text === "[") {
    state.lexer.take();
    if (state.lexer.peek().text === "]") state.lexer.take();
    else state.stack.push(typeFrame("tuple", "]"));
    return undefined;
  }
  if (token.kind === "word") {
    state.lexer.take();
    const valid = credentialTypeName(token.text);
    deliverType(top, { valid, type: valid, name: token.text, end: token.end });
  } else if (token.kind === "string" || token.kind === "number") {
    state.lexer.take();
    deliverType(top, { valid: true, type: false, end: token.end });
  } else return null;
  state.lastEnd = token.end;
  return undefined;
}

function advanceType(state: CredentialTypeState): CredentialTypeStep {
  const top = state.stack[state.stack.length - 1]!;
  const token = state.lexer.peek();
  if (top.close && token.text === top.close) return stepTypeClose(state, top, token);
  if (token.kind === "end") return state.stack.length === 1 ? finishType(top) : null;
  return top.operand ? stepTypePrimary(state, top, token) : stepTypePostfix(state, top, token);
}

/** Same lexer and delimiter discipline as expressions, with type productions. */
function parseCredentialType(
  text: string,
  start: number,
  wordName: CredentialWordName,
  initialArguments = false,
  stopAtArrow = false,
): CredentialTypeNode | null {
  const lexer = new CredentialLexer(text, start);
  const stack: CredentialTypeFrame[] = initialArguments
    ? [typeFrame("arguments", ">", { valid: true, type: true, end: start })]
    : [typeFrame("root")];
  if (initialArguments && lexer.take().text !== "<") return null;
  const state: CredentialTypeState = { text, wordName, lexer, stack, lastEnd: start, stopAtArrow };
  while (state.stack.length > 0) {
    const result = advanceType(state);
    if (result !== undefined) return result;
  }
  return null;
}

function readCredentialTypeEnd(
  text: string,
  start: number,
  wordName: CredentialWordName = defaultWordName,
): number | null {
  const node = parseCredentialType(text, start, wordName);
  return node?.valid && node.type ? node.end : null;
}

function isCredentialType(value: string, wordName: CredentialWordName = defaultWordName): boolean {
  const text = value.trim();
  const node = parseCredentialType(text, 0, wordName);
  return !!node?.valid && node.type && node.end === text.length;
}

interface ScanSpan {
  start: number;
  end: number;
}

interface UrlExtent {
  end: number;
  at: number;
}

function urlSchemeStart(text: string, separator: number): number | null {
  let start = separator;
  while (start > 0 && /[A-Za-z0-9+.-]/.test(text[start - 1]!)) start -= 1;
  return /[A-Za-z]/.test(text[start] ?? "") ? start : null;
}

function urlExtent(
  text: string,
  view: DetectionView,
  original: string,
  schemeStart: number,
  authorityStart: number,
): UrlExtent {
  let end = authorityStart;
  let at = -1;
  while (end < text.length) {
    if (/[\s"'`<>},)]/.test(text[end]!) && isValueDelimiter(view, original, end)) break;
    if (
      /["'`]/.test(text[end]!) &&
      text[schemeStart - 1] === text[end] &&
      mappedQuoteMayClose(view, schemeStart - 1, end)
    )
      break;
    if (text[end] === "@") at = end;
    end += 1;
  }
  return { end, at };
}

function urlPasswordSpan(
  text: string,
  view: DetectionView,
  original: string,
  authorityStart: number,
  at: number,
): ScanSpan | null {
  if (at < authorityStart) return null;
  const colon = text.indexOf(":", authorityStart);
  if (colon < authorityStart || colon >= at) return null;
  const start = colon + 1;
  const value = decodedCredentialValue(text, view, original, start, at);
  return credentialValueShape(value, 8) ? { start, end: at } : null;
}

/** URL-owned host/path bytes only; query and neighbouring JSON values still scan. */
function urlParts(
  text: string,
  view: DetectionView,
  original: string,
): { excluded: ScanSpan[]; passwords: ScanSpan[] } {
  const excluded: ScanSpan[] = [];
  const passwords: ScanSpan[] = [];
  const scanner = /:\/\//g;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const schemeStart = urlSchemeStart(text, match.index);
    if (schemeStart === null) continue;
    const authorityStart = match.index + match[0].length;
    const { end, at } = urlExtent(text, view, original, schemeStart, authorityStart);
    const hostStart = at < 0 ? authorityStart : at + 1;
    let query = hostStart;
    while (query < end && text[query] !== "?" && text[query] !== "#") query += 1;
    excluded.push({ start: schemeStart, end: query });
    const password = urlPasswordSpan(text, view, original, authorityStart, at);
    if (password) passwords.push(password);
    scanner.lastIndex = end;
  }
  return { excluded, passwords };
}

function dataUriSpans(text: string): ScanSpan[] {
  const spans: ScanSpan[] = [];
  const scanner = /\bdata:/gi;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    // A bounded, anchored MIME header rejects data:data:data... in constant time.
    const header = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.exec(
      text.slice(match.index, match.index + 512),
    );
    if (!header) continue;
    let end = match.index + header[0].length;
    while (end < text.length && !/[\s"'<>)}]/.test(text[end]!)) end += 1;
    spans.push({ start: match.index, end });
    scanner.lastIndex = end;
  }
  return spans;
}

function entropySpans(text: string, exclusions: ScanSpan[]): ScanSpan[] {
  const spans: ScanSpan[] = [];
  let excluded = 0;
  // Separators partition minified JSON, assignments and shell fragments. An
  // excluded routing label never suppresses another value in the same chunk.
  const candidates = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
  let match: RegExpExecArray | null;
  while ((match = candidates.exec(text)) !== null) {
    const start = match.index;
    while (exclusions[excluded] && exclusions[excluded]!.end <= start) excluded += 1;
    const range = exclusions[excluded];
    if (range && range.start <= start) {
      candidates.lastIndex = Math.max(candidates.lastIndex, range.end);
      continue;
    }
    const value = match[0];
    if (/^sha(?:1|224|256|384|512)-/i.test(value) || /^SHA(?:-?\d+)?[a-f0-9]{32,}$/i.test(value))
      continue;
    if (!isEntropyValue(value)) continue;
    // Preserve explicit filename extensions and file:line references, which are
    // outside the base64 alphabet. Bare 40-byte base64 has no such suffix.
    const suffix = text.slice(start + value.length, start + value.length + 32);
    if (
      /^\.[A-Za-z][A-Za-z0-9]{0,7}(?=[:\s"'`,;)}\]]|$)/.test(suffix) &&
      isWordlikePath(value + suffix.split(/[\s"'`,;)}\]]/, 1)[0])
    )
      continue;
    spans.push({ start, end: start + value.length });
  }
  return spans;
}

function cookieLineEnd(text: string, view: DetectionView, original: string, start: number): number {
  let end = start;
  while (end < text.length && !(text[end] === "\n" && isValueDelimiter(view, original, end)))
    end += 1;
  return end;
}

function cookieValueEnd(
  text: string,
  view: DetectionView,
  original: string,
  start: number,
  lineEnd: number,
  opening: number,
  quote: string | undefined,
): number {
  let end = start;
  while (end < lineEnd) {
    if (/[;\s]/.test(text[end]!) && isValueDelimiter(view, original, end)) break;
    if (text[end] === quote && mappedQuoteMayClose(view, opening, end)) break;
    end += 1;
  }
  return end;
}

interface CookieField {
  next: number;
  span: ScanSpan | null;
}

function readCookieField(
  text: string,
  view: DetectionView,
  original: string,
  fieldStart: number,
  lineEnd: number,
): CookieField {
  let cursor = fieldStart;
  while (cursor < lineEnd && text[cursor] !== "=" && text[cursor] !== ";") cursor += 1;
  if (text[cursor] !== "=") return { next: cursor + 1, span: null };
  const key = text.slice(fieldStart, cursor).trim();
  cursor += 1;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  const opening = cursor;
  const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor++] : undefined;
  const start = cursor;
  const end = cookieValueEnd(text, view, original, start, lineEnd, opening, quote);
  cursor = end;
  const span =
    /^[A-Za-z0-9_-]+$/.test(key) &&
    credentialValueShape(decodedCredentialValue(text, view, original, start, end))
      ? { start, end }
      : null;
  if (text[cursor] === quote) cursor += 1;
  while (cursor < lineEnd && text[cursor] !== ";") cursor += 1;
  return { next: cursor + 1, span };
}

function cookieSpans(text: string, view: DetectionView, original: string): ScanSpan[] {
  const spans: ScanSpan[] = [];
  const scanner = /\b(?:Cookie|Set-Cookie):[ \t]*/gi;
  let header: RegExpExecArray | null;
  while ((header = scanner.exec(text)) !== null) {
    let cursor = header.index + header[0].length;
    const lineEnd = cookieLineEnd(text, view, original, cursor);
    while (cursor < lineEnd) {
      const field = readCookieField(text, view, original, cursor, lineEnd);
      if (field.span) spans.push(field.span);
      cursor = field.next;
    }
    scanner.lastIndex = lineEnd;
  }
  return spans;
}

function isClosedPlaceholder(value: string): boolean {
  return value === "" || /^(?:\*{3,}|x{4,}|\.{3}|…|\[REDACTED\]|<[^<>\r\n]+>|N\/A)$/i.test(value);
}

function isStrictVersion(value: string): boolean {
  return (
    value === "*" ||
    /^(?:[v~^]?\d+(?:\.(?:\d+|x|\*))+|(?:>=?|<=?)\d+(?:\.\d+)*(?: +<(?:=)?\d+(?:\.\d+)*)?|workspace:\*|npm:[a-z0-9@/_-]+@\d+(?:\.\d+)+)$/i.test(
      value,
    )
  );
}

function isWordOnlyName(value: string): boolean {
  return (
    !/\d/.test(value) &&
    (/^[a-z]+$/.test(value) ||
      /^[A-Z]+$/.test(value) ||
      isWordlikeIdentifier(value) ||
      /^[a-z]+(?:[-_./][a-z]+)+$/.test(value))
  );
}

function credentialValueShape(value: string, minimum = 12): boolean {
  if (isFortyCharacterBase64(value)) return true;
  if (
    value.length < minimum ||
    /\s/.test(value) ||
    isClosedPlaceholder(value) ||
    isCredentialExpression(value) ||
    isCredentialType(value) ||
    isStrictVersion(value)
  )
    return false;
  if (/^[a-f0-9]{32,}$/i.test(value)) return true;
  if (isWordOnlyName(value)) return false;
  const location = value.replace(/%5c/gi, "\\");
  if (
    /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?:-\d+)?)?$/.test(location) &&
    (isWordlikePath(location) || /^(?:[A-Za-z]:\\|\\)/.test(location))
  )
    return false;
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));
  return classes >= 2;
}

function isEntropyValue(value: string): boolean {
  if (isFortyCharacterBase64(value)) return true;
  if (
    value.length < 32 ||
    isKnownIdentifier(value) ||
    isWordlikePath(value) ||
    isWordlikeIdentifier(value) ||
    isDelimitedIdentifier(value)
  )
    return false;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value)) return false;
  return entropyOf(value) >= 3;
}

function mappedQuoteMayClose(view: DetectionView, opening: number, closing: number): boolean {
  const width = (index: number) =>
    (view.ends?.[index] ?? index + 1) - (view.starts?.[index] ?? index);
  return width(opening) === width(closing);
}

function isValueDelimiter(view: DetectionView, original: string, index: number): boolean {
  if (isLiteralCharacter(view, index)) return true;
  const raw = original.slice(view.starts?.[index] ?? index, view.ends?.[index] ?? index + 1);
  return /^\\+[nrt]$/.test(raw);
}

function decodedCredentialValue(
  text: string,
  view: DetectionView,
  _original: string,
  start: number,
  end: number,
): string {
  const parts: string[] = [];
  for (let index = start; index < end; index += 1) {
    const character = text[index]!;
    parts.push(
      !isLiteralCharacter(view, index) && !isOpaqueCharacter(character)
        ? `%${character.charCodeAt(0).toString(16)}`
        : character,
    );
  }
  return parts.join("");
}

function assignmentSpans(text: string, view: DetectionView, original: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  for (const candidate of labelledValues(
    text,
    (opening, closing) => mappedQuoteMayClose(view, opening, closing),
    (index) => isValueDelimiter(view, original, index),
  )) {
    const { start, end, tier, copula } = candidate;
    const value = decodedCredentialValue(text, view, original, start, end);
    if (start === end || text.startsWith(SECRET_ANSWER_NOTICE, start)) continue;
    const expressionEnd = readCredentialExpressionEnd(text, start);
    if (
      expressionEnd !== null &&
      expressionEnd >= end &&
      (candidate.mode === "label" || expressionEnd === end)
    )
      continue;
    const typeEnd = readCredentialTypeEnd(text, candidate.openQuote ?? start);
    if (typeEnd !== null && typeEnd >= end && (candidate.mode === "label" || typeEnd === end))
      continue;
    if (
      isClosedPlaceholder(value) ||
      isStrictVersion(value) ||
      isCredentialType(value) ||
      isCredentialExpression(value)
    )
      continue;
    if (copula || tier === "credential") {
      if (credentialValueShape(value)) spans.push({ start, end });
    } else spans.push({ start, end });
  }
  return spans;
}

function authorizationSpans(
  text: string,
  view: DetectionView,
  original: string,
): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = /\b(?:Bearer|Basic|Token)[ \t]+/gi;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const value = readLocalCredentialValue(
      text,
      match.index + match[0].length,
      (opening, closing) => mappedQuoteMayClose(view, opening, closing),
      "label",
      (index) => isValueDelimiter(view, original, index),
    );
    value.value = decodedCredentialValue(text, view, original, value.start, value.end);
    const header = /\bauthorization["']?\s{0,16}:\s{0,16}["']?\s*$/i.test(
      text.slice(Math.max(0, match.index - 96), match.index),
    );
    if (
      credentialValueShape(value.value) ||
      (header &&
        value.value.length >= 12 &&
        /^[A-Z0-9_-]+$/.test(value.value) &&
        !isClosedPlaceholder(value.value))
    )
      spans.push({ start: value.start, end: value.end });
    scanner.lastIndex = Math.max(scanner.lastIndex, value.end);
  }
  return spans;
}

function flagSpans(text: string, view: DetectionView, original: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = /--(password|passwd|passphrase|token|api[-_]key|secret)(?:=|[ \t]+)/g;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const value = readLocalCredentialValue(
      text,
      match.index + match[0].length,
      (opening, closing) => mappedQuoteMayClose(view, opening, closing),
      "label",
      (index) => isValueDelimiter(view, original, index),
    );
    value.value = decodedCredentialValue(text, view, original, value.start, value.end);
    const password = /^(?:password|passwd|passphrase)$/.test(match[1]!);
    if (
      value.end > value.start &&
      !isClosedPlaceholder(value.value) &&
      !isCredentialExpression(value.value) &&
      credentialValueShape(value.value, password ? 8 : 12)
    )
      spans.push({ start: value.start, end: value.end });
    scanner.lastIndex = Math.max(scanner.lastIndex, value.end);
  }
  return spans;
}

function curlUserSpans(text: string, view: DetectionView, original: string): SecretPromptSpan[] {
  const spans: SecretPromptSpan[] = [];
  const scanner = /(?:^|\s)(?:-u|--user)(?:=|[ \t]+)/g;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const value = readLocalCredentialValue(
      text,
      match.index + match[0].length,
      (opening, closing) => mappedQuoteMayClose(view, opening, closing),
      "label",
      (index) => isValueDelimiter(view, original, index),
    );
    value.value = decodedCredentialValue(text, view, original, value.start, value.end);
    const colon = value.value.indexOf(":");
    if (colon >= 0 && credentialValueShape(value.value.slice(colon + 1), 8))
      spans.push({ start: value.start + colon + 1, end: value.end });
    scanner.lastIndex = Math.max(scanner.lastIndex, value.end);
  }
  return spans;
}

function scanSecretSpans(text: string, includeEntropy: boolean): SecretPromptSpan[] {
  const view = detectionView(text);
  const urls = urlParts(view.text, view, text);
  const streams = [...LITERAL_PATTERNS, JWT_PATTERN].map((pattern) =>
    literalSpans(view.text, pattern, view),
  );
  streams.push(
    wrappedLiteralSpans(view.text, LITERAL_PATTERNS),
    privateKeySpans(view.text),
    assignmentSpans(view.text, view, text),
    authorizationSpans(view.text, view, text),
    urls.passwords,
    flagSpans(view.text, view, text),
    curlUserSpans(view.text, view, text),
    cookieSpans(view.text, view, text),
  );
  if (includeEntropy)
    streams.push(entropySpans(view.text, mergeSpans([urls.excluded, dataUriSpans(view.text)])));
  return mergeSpans(streams).map((span) => ({
    start: view.starts?.[span.start] ?? span.start,
    end: view.ends?.[span.end - 1] ?? span.end,
  }));
}

export function secretPromptSpans(text: string, context?: string): SecretPromptSpan[] {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return [];
  if (
    context !== undefined &&
    !/^\/[a-z]+(?:\s|$)/.test(text) &&
    !/^(?:yes|no)$/i.test(text) &&
    /^\S+$/.test(text) &&
    endsWithCredentialRequest(detectionView(context).text)
  )
    return [{ start: 0, end: text.length }];
  return scanSecretSpans(text, true);
}

export function redactSecretKey(text: string): string {
  if (text === "" || text === SECRET_ANSWER_NOTICE) return text;
  return scanSecretSpans(text, false).length > 0 ? SECRET_ANSWER_NOTICE : text;
}

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

export function redactSecretAnswer(text: string, context?: string): string {
  if (text === "" || text === SECRET_ANSWER_NOTICE || /^(?:yes|no)$/i.test(text)) return text;
  if (context !== undefined && requestsCredential(detectionView(context).text))
    return SECRET_ANSWER_NOTICE;
  const redacted = redactSecretPrompt(text);
  if (redacted !== text) return redacted;
  const value = unwrapNeutralAnswer(text);
  const neutralSecret =
    /^[A-Za-z0-9+/_!#$%~-]{16,}={0,2}$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    (/[\d+/]/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value))) &&
    !isKnownIdentifier(value) &&
    !isDelimitedIdentifier(value) &&
    !isOrdinaryAnswerIdentifier(value) &&
    !isCredentialExpression(value) &&
    !isWordlikePath(value) &&
    !/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|data:|sha(?:1|224|256|384|512)-)/i.test(value);
  return neutralSecret ? SECRET_ANSWER_NOTICE : text;
}
