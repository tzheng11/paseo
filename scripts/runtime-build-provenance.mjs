import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function runtimeBuildOutputPaths(repoRoot) {
  return [
    path.join(repoRoot, "packages/server/dist/server/server/impower-build.json"),
    path.join(repoRoot, "packages/server/dist/src/server/impower-build.json"),
  ];
}
export function runtimeBuildIdentity(source) {
  const payload = {
    schemaVersion: 1,
    distributionVersion: source.distributionVersion,
    upstreamVersion: source.upstreamVersion,
    upstreamCommit: source.upstreamCommit,
    sourceCommit: source.sourceCommit,
    sourceTree: source.sourceTree,
    sourceDirty: source.sourceDirty,
    lockSha256: source.lockSha256,
  };
  return {
    ...payload,
    buildId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

export async function writeRuntimeBuildProvenance(repoRoot, outputs) {
  const git = async (...args) => (await exec("git", args, { cwd: repoRoot })).stdout.trim();
  const [sourceCommit, sourceTree, status, rootBytes, lock] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
    git("status", "--porcelain", "--untracked-files=normal"),
    readFile(path.join(repoRoot, "package.json")),
    readFile(path.join(repoRoot, "package-lock.json")),
  ]);
  const root = JSON.parse(rootBytes);
  const upstream = root.paseoDistribution;
  if (!upstream?.upstreamCommit || !upstream.upstreamVersion)
    throw new Error("Missing distribution source binding");
  const result = runtimeBuildIdentity({
    distributionVersion: root.version,
    upstreamVersion: upstream.upstreamVersion,
    upstreamCommit: upstream.upstreamCommit,
    sourceCommit,
    sourceTree,
    sourceDirty: status.length !== 0,
    lockSha256: createHash("sha256").update(lock).digest("hex"),
  });
  for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await writeRuntimeBuildProvenance(root, runtimeBuildOutputPaths(root));
}
