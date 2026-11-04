import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  runtimeBuildIdentity,
  runtimeBuildOutputPaths,
  writeRuntimeBuildProvenance,
} from "../../../../scripts/runtime-build-provenance.mjs";
import { readRuntimeBuildIdentity } from "./runtime-build.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "runtime-build-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const source = {
  distributionVersion: "0.15.0-impower",
  upstreamVersion: "0.15.0",
  upstreamCommit: "1".repeat(40),
  sourceCommit: "2".repeat(40),
  sourceTree: "3".repeat(40),
  sourceDirty: false,
  lockSha256: "4".repeat(64),
};
test("runtime reads the producer's immutable build identity independently of JSON key order", async () => {
  const build = runtimeBuildIdentity(source);
  const file = path.join(home, "build.json");
  await writeFile(file, JSON.stringify(Object.fromEntries(Object.entries(build).toReversed())));
  expect(readRuntimeBuildIdentity(pathToFileURL(file))).toEqual(build);
  const dirty = runtimeBuildIdentity({ ...source, sourceDirty: true });
  expect(dirty.buildId).not.toBe(build.buildId);
});
test("a missing build is unverified; malformed or tampered provenance fails explicitly", async () => {
  const file = path.join(home, "build.json");
  expect(readRuntimeBuildIdentity(pathToFileURL(file))).toBeUndefined();
  const build = runtimeBuildIdentity(source);
  await writeFile(file, JSON.stringify({ ...build, sourceCommit: "5".repeat(40) }));
  expect(() => readRuntimeBuildIdentity(pathToFileURL(file))).toThrow("digest mismatch");
  await writeFile(file, "{broken");
  expect(() => readRuntimeBuildIdentity(pathToFileURL(file))).toThrow();
  expect(await readFile(file, "utf8")).toBe("{broken");
});

test("the actual producer binds both compiled entry trees to the same Git identity and detects untracked source", async () => {
  await writeFile(
    path.join(home, "package.json"),
    JSON.stringify({
      version: source.distributionVersion,
      paseoDistribution: {
        upstreamVersion: source.upstreamVersion,
        upstreamCommit: source.upstreamCommit,
      },
    }),
  );
  await writeFile(path.join(home, "package-lock.json"), "{}");
  await writeFile(path.join(home, ".gitignore"), "packages/server/dist/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: home,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("add", "package.json", "package-lock.json", ".gitignore");
  // Only this disposable fixture repository: do not run a user's global commit hooks.
  git(
    "-c",
    `core.hooksPath=${path.join(home, "empty-fixture-hooks")}`,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  const paths = runtimeBuildOutputPaths(home);
  const clean = await writeRuntimeBuildProvenance(home, paths);
  expect(clean.sourceCommit).toBe(git("rev-parse", "HEAD"));
  expect(clean.sourceTree).toBe(git("rev-parse", "HEAD^{tree}"));
  expect(clean.sourceDirty).toBe(false);
  for (const file of paths) expect(readRuntimeBuildIdentity(pathToFileURL(file))).toEqual(clean);
  await writeFile(path.join(home, "new-source.ts"), "export const changed = true;");
  const dirty = await writeRuntimeBuildProvenance(home, paths);
  expect(dirty.sourceDirty).toBe(true);
  expect(dirty.buildId).not.toBe(clean.buildId);
});

test("Git-free Nix and Docker source builds remain explicitly unverified and remove stale build files", async () => {
  await writeFile(
    path.join(home, "package.json"),
    JSON.stringify({
      version: source.distributionVersion,
      paseoDistribution: {
        upstreamVersion: source.upstreamVersion,
        upstreamCommit: source.upstreamCommit,
      },
    }),
  );
  await writeFile(path.join(home, "package-lock.json"), "{}");
  const outputs = runtimeBuildOutputPaths(home);
  for (const file of outputs) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(runtimeBuildIdentity(source)));
  }
  expect(await writeRuntimeBuildProvenance(home, outputs)).toBeUndefined();
  for (const file of outputs) expect(readRuntimeBuildIdentity(pathToFileURL(file))).toBeUndefined();
});
