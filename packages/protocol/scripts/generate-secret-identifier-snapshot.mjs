import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const listed = execFileSync("rg", ["--files", "packages", "-g", "**/src/**/*.ts"], {
  cwd: repository,
  encoding: "utf8",
});
const files = listed
  .trim()
  .split("\n")
  .filter(
    (path) =>
      !/(?:^|\/)(?:__tests__|__fixtures__|__mocks__|tests?|fixtures?|mocks?)(?:[-_][^/]*)?(?:\/|$)/i.test(
        path,
      ) && !/(?:^|\/|[._-])(?:tests?|spec|fixtures?|mocks?)(?:[._-]|$)/i.test(path),
  )
  .sort();
const identifiers = new Set();
const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard);
let occurrences = 0;
const sources = createHash("sha256");
for (const path of files) {
  const source = readFileSync(resolve(repository, path), "utf8");
  sources.update(path).update("\0").update(source).update("\0");
  scanner.setText(source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.Identifier) continue;
    const identifier = scanner.getTokenValue();
    if (identifier.length < 16) continue;
    occurrences += 1;
    identifiers.add(identifier);
  }
}
const snapshot = {
  method:
    "TypeScript scanner Identifier tokens >=16 UTF-16 characters in non-test packages/**/src/**/*.ts; unique names, strings and comments excluded",
  exclusions:
    "test/spec/fixture/mock filename components and test/fixture/mock directories, including suffixed directories such as test-utils",
  files: files.length,
  occurrences,
  count: identifiers.size,
  sourceSha256: sources.digest("hex"),
  identifiers: [...identifiers].sort(),
};
const destination = resolve(repository, "packages/protocol/tests/secret-answer-identifiers.json");
writeFileSync(destination, JSON.stringify(snapshot, null, 2) + "\n");
process.stdout.write(
  JSON.stringify({ files: files.length, occurrences, count: identifiers.size }) + "\n",
);
