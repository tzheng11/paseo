import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { redactSecretPrompt } from "./secret-answer.js";

interface SourceLine {
  path: string;
  line: number;
  text: string;
}

interface SourceLineSnapshot {
  count: number;
  sourceSha256: string;
  lines: SourceLine[];
}

const snapshot: SourceLineSnapshot = JSON.parse(
  readFileSync(new URL("../tests/secret-answer-source-lines.json", import.meta.url), "utf8"),
);

function residueClass(text: string): string {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) return "comment";
  if (/\b(?:const|let|var|function|type|interface)\b/.test(text)) return "declaration";
  if (/\b(?:Bearer|Basic)\b/i.test(text)) return "authorization-syntax";
  if (/\b(?:password|token|secret|credential|auth|pin)[\w]*\s*[=:]/i.test(text)) {
    return "credential-property-syntax";
  }
  return "source-expression-or-prose";
}

test("K3 keeps every snapshotted non-test source line byte-exact", () => {
  expect(snapshot.lines.length).toBe(snapshot.count);
  expect(snapshot.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  const residue = snapshot.lines.flatMap(({ path, line, text }) =>
    redactSecretPrompt(text) === text ? [] : [{ path, line, class: residueClass(text) }],
  );
  // Failures contain locations and structural classes only. Never print source
  // text or detector output: an apparent credential must not enter a test log.
  expect(residue).toEqual([]);
});
