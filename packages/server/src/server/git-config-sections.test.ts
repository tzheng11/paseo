import { describe, expect, it } from "vitest";

import { diffGitConfigSections, parseGitConfigSections } from "./git-config-sections.js";

const BASE_CONFIG = `[core]
\trepositoryformatversion = 0
\tbare = false
[remote "origin"]
\turl = git@example:org/repo
\tfetch = +refs/heads/*:refs/remotes/origin/*
\tpromisor = true
[branch "develop"]
\tremote = origin
\tmerge = refs/heads/develop
[branch "feature/One"]
\tremote = origin
\tmerge = refs/heads/feature/One
`;

function diff(next: string) {
  return diffGitConfigSections(parseGitConfigSections(BASE_CONFIG), parseGitConfigSections(next));
}

describe("git config sections", () => {
  it("reports no change for an identical rewrite", () => {
    expect(diff(BASE_CONFIG)).toEqual({ branches: new Set(), remotes: false, other: false });
  });

  it("names only the branch whose upstream was added", () => {
    const next = `${BASE_CONFIG}[branch "fix/two"]\n\tremote = origin\n\tmerge = refs/heads/fix/two\n`;

    expect(diff(next)).toEqual({ branches: new Set(["fix/two"]), remotes: false, other: false });
  });

  it("names edited and removed branch sections with their original case", () => {
    const next = BASE_CONFIG.replace("refs/heads/develop", "refs/heads/main").replace(
      `[branch "feature/One"]\n\tremote = origin\n\tmerge = refs/heads/feature/One\n`,
      "",
    );

    expect(diff(next).branches).toEqual(new Set(["develop", "feature/One"]));
  });

  it("flags remote and other section changes separately", () => {
    expect(diff(BASE_CONFIG.replace("org/repo", "org/other"))).toEqual({
      branches: new Set(),
      remotes: true,
      other: false,
    });
    expect(diff(BASE_CONFIG.replace("bare = false", "bare = false\n\texcludesFile = x"))).toEqual({
      branches: new Set(),
      remotes: false,
      other: true,
    });
    expect(diff(`${BASE_CONFIG}[status]\n\tshowUntrackedFiles = no\n`).other).toBe(true);
  });

  it("treats a branch section without a name as another setting", () => {
    expect(diff(`${BASE_CONFIG}[branch]\n\tautoSetupMerge = always\n`)).toEqual({
      branches: new Set(),
      remotes: false,
      other: true,
    });
  });

  it("reads escaped and deprecated subsection headers", () => {
    const sections = parseGitConfigSections(
      '[branch "a\\"b"]\n\tremote = origin\n[Branch.Old]\n[branch "x]y"]\n',
    );

    expect([...sections.keys()]).toEqual(['branch a"b', "branch old", "branch x]y"]);
  });
});
