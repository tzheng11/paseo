import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const sources = createHash("sha256");
const lines = [];
let matchingFiles = 0;
for (const path of files) {
  const source = readFileSync(resolve(repository, path), "utf8");
  sources.update(path).update("\0").update(source).update("\0");
  let matchedFile = false;
  for (const [index, text] of source.split("\n").entries()) {
    if (!/token|secret|key|password|pass|credential|auth|pin/i.test(text)) continue;
    lines.push({ path, line: index + 1, text });
    matchedFile = true;
  }
  if (matchedFile) matchingFiles += 1;
}
const snapshot = {
  method:
    "Every complete line containing token|secret|key|password|pass|credential|auth|pin (case-insensitive substring) in non-test packages/**/src/**/*.ts; 1-based line numbers and original bytes excluding LF",
  exclusions:
    "test/spec/fixture/mock filename components and test/fixture/mock directories, including suffixed directories such as test-utils",
  files: files.length,
  matchingFiles,
  count: lines.length,
  sourceSha256: sources.digest("hex"),
  lines,
};
const destination = resolve(repository, "packages/protocol/tests/secret-answer-source-lines.json");
writeFileSync(destination, JSON.stringify(snapshot, null, 2) + "\n");
// Source text is deliberately never printed, including when a line resembles a credential.
process.stdout.write(
  JSON.stringify({ files: files.length, matchingFiles, count: lines.length }) + "\n",
);
