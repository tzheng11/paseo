import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  createPathEquivalenceMatcher,
  createLexicalWatchPathFilter,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("lexical watcher filtering", () => {
  test("filters a dependency burst against many ignored roots and retains a tracked edit", () => {
    const ignoredRoots = Array.from({ length: 198 }, (_, index) => `/repo/ignored-${index}`);
    ignoredRoots.push("/repo/node_modules");
    const relevant = createLexicalWatchPathFilter({ root: "/repo", ignoredRoots });
    const events = Array.from(
      { length: 26_079 },
      (_, index) => `/repo/node_modules/.pnpm/pkg-${index}/node_modules/pkg/file.js`,
    );

    expect(events.some(relevant)).toBe(false);
    expect([...events, "/repo/src/changed.ts"].filter(relevant)).toEqual(["/repo/src/changed.ts"]);
  });

  test("keeps root metadata, exclusions and similarly named siblings distinct", () => {
    const relevant = createLexicalWatchPathFilter({
      root: "/repo",
      ignoredRoots: ["/repo/.git", "/repo/node_modules"],
    });
    expect(
      [
        "/repo",
        "/repo/",
        "/repo/.git",
        "/repo/.git/HEAD",
        "/repo/node_modules/deleted/file.js",
      ].filter(relevant),
    ).toEqual([]);
    expect(
      ["/repo/.github/ci.yml", "/repo/node_modules-extra/file.js", "/repo/src/deleted.ts"].filter(
        relevant,
      ),
    ).toEqual(["/repo/.github/ci.yml", "/repo/node_modules-extra/file.js", "/repo/src/deleted.ts"]);
    expect(relevant("/repo-other/file.js")).toBe(false);
    expect(relevant("/repo/../outside/file.js")).toBe(false);
  });

  test.each([
    ["C:\\Repo", "c:/REPO"],
    [String.raw`\\server\share\Repo`, String.raw`\\SERVER\share\REPO`],
    [String.raw`\\?\C:\Repo`, "c:/REPO"],
  ])("normalizes Windows observer paths under %s", (root, eventRoot) => {
    const relevant = createLexicalWatchPathFilter({
      root,
      ignoredRoots: [`${root}\\node_modules`],
    });
    expect(relevant(eventRoot)).toBe(false);
    expect(relevant(`${eventRoot}/NODE_MODULES/deleted/file.js`)).toBe(false);
    expect(relevant(`${eventRoot}/node_modules-extra/file.js`)).toBe(true);
    expect(relevant(`${eventRoot}/src/../tracked.ts`)).toBe(true);
  });

  test("uses lexical symlink roots and handles filesystem roots", () => {
    const relevant = createLexicalWatchPathFilter({
      root: "/workspace-alias",
      ignoredRoots: ["/workspace-alias/node_modules"],
    });
    expect(relevant("/workspace-alias/node_modules/package/file.js")).toBe(false);
    expect(relevant("/workspace-alias/src/tracked.ts")).toBe(true);
    const rootFilter = createLexicalWatchPathFilter({ root: "/", ignoredRoots: ["/ignored"] });
    expect(rootFilter("/")).toBe(false);
    expect(rootFilter("/ignored/file.js")).toBe(false);
    expect(rootFilter("/tracked.ts")).toBe(true);
  });
});

describe("path equivalence", () => {
  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test.each([
    { root: "/repo", candidate: "/repo/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo/..drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/...drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/docs/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo", inside: true },
    { root: "/repo", candidate: "/repo/../sibling/notes.md", inside: false },
    { root: "/repo", candidate: "/repo/..drafts/../../outside.txt", inside: false },
    { root: "/repo", candidate: "/repo-other/notes.md", inside: false },
    { root: "C:\\Repo", candidate: "c:/repo/..notes.txt", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\...drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..\\sibling\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "C:\\Repo-other\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "D:\\Repo\\..notes.txt", inside: false },
    {
      root: String.raw`\\server\share\repo`,
      candidate: String.raw`\\server\share\repo\..drafts\notes.md`,
      inside: true,
    },
    {
      root: String.raw`\\?\C:\Repo`,
      candidate: "C:\\Repo\\..notes.txt",
      inside: true,
    },
  ])("checks named path containment for $candidate", ({ root, candidate, inside }) => {
    expect(isPathInsideRoot(root, candidate)).toBe(inside);
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
