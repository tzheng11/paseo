import { win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { createObserverPaths } from "./paths.js";

test.each(["darwin", "win32"] as const)(
  "indexed ignores preserve literal subtree boundaries on %s",
  (platform) => {
    const paths = createObserverPaths(platform);
    const root = platform === "win32" ? "C:\\repo" : "/repo";
    const sep = platform === "win32" ? "\\" : "/";
    const ignored = Array.from({ length: 1000 }, (_, i) => `${root}${sep}pkg-${i}${sep}[output]`);
    const matches = paths.ignoredMatcher(ignored);
    expect(matches(`${ignored[999]}${sep}nested${sep}file.js`)).toBe(true);
    expect(matches(ignored[0])).toBe(true);
    expect(matches(`${ignored[999]}-source${sep}file.js`)).toBe(false);
    expect(matches(`${root}${sep}pkg-999${sep}src${sep}file.js`)).toBe(false);
    if (platform === "win32")
      expect(matches(`${ignored[500].toUpperCase()}${sep}FILE.JS`)).toBe(true);
    else expect(matches(`${ignored[500].toUpperCase()}${sep}file.js`)).toBe(false);
  },
);

// m3 regression: plain lexicographic sort does not put a parent immediately
// before its descendants. A sibling whose name extends the parent's with a
// character that sorts below the separator (POSIX "/" = 0x2F, so "-" and "."
// qualify) lands between them, so the single backward look collapse()
// relies on misses the real parent and keeps a redundant descendant scope.
// This is this repo's own layout: packages/app, packages/app-web,
// packages/app/src.
describe("collapse", () => {
  test("drops a redundant descendant but keeps a sibling whose name extends the parent's", () => {
    const paths = createObserverPaths("linux");
    const parent = "/repo/packages/app";
    const sibling = "/repo/packages/app-web";
    const descendant = "/repo/packages/app/src";

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });

  test("keeps unrelated roots and drops nested duplicates regardless of input order", () => {
    const paths = createObserverPaths("linux");
    const a = "/repo/a";
    const aChild = "/repo/a/child";
    const b = "/repo/b";

    expect(paths.collapse([aChild, b, a]).sort()).toEqual([a, b].sort());
  });

  // The selected path strategy supplies separators and case comparison, so
  // Windows paths can be checked on every CI host.
  test("collapses win32 paths case-insensitively even with mismatched casing", () => {
    const paths = createObserverPaths("win32");
    const sep = win32.sep;
    const parent = `C:${sep}repo${sep}packages${sep}app`;
    const sibling = `C:${sep}repo${sep}packages${sep}APP-web`;
    const descendant = `c:${sep}repo${sep}packages${sep}app${sep}src`;

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });
});
