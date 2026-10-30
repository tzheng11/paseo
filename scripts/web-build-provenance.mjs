import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Bind provenance to the exported HTML and its actual assets, never a copied filename. */
export async function webBuildManifest(directory, source) {
  const root = await realpath(directory);
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === "build-info.json") continue;
      if (entry.isDirectory()) await walk(absolute);
      else {
        const resolved = await realpath(absolute);
        if (path.relative(root, resolved).startsWith("..") || entry.isSymbolicLink())
          throw new Error(`Export contains an unqualified asset: ${relative}`);
        const bytes = await readFile(absolute);
        files.push({ path: relative, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => {
    const url = new URL(match[1], "https://export.invalid/");
    if (url.origin !== "https://export.invalid")
      throw new Error("Export references an external script");
    const relative = decodeURIComponent(url.pathname.slice(1));
    const file = files.find((candidate) => candidate.path === relative);
    if (!file) throw new Error(`Export script is missing: ${relative}`);
    return file;
  });
  if (!scripts.length) throw new Error("Export has no script entry");
  return {
    schemaVersion: 1,
    ...source,
    index: files.find((file) => file.path === "index.html"),
    scripts,
    files,
  };
}

export async function writeWebBuildProvenance(directory, repoRoot) {
  const git = async (...args) => (await exec("git", args, { cwd: repoRoot })).stdout.trim();
  const [sourceCommit, sourceTree, status, packageBytes, lockBytes] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
    git("status", "--porcelain", "--untracked-files=no"),
    readFile(path.join(repoRoot, "package.json")),
    readFile(path.join(repoRoot, "package-lock.json")),
  ]);
  const manifest = await webBuildManifest(directory, {
    sourceCommit,
    sourceTree,
    sourceDirty: status.length > 0,
    packageVersion: JSON.parse(packageBytes).version,
    lockSha256: digest(lockBytes),
    flavor: "browser",
  });
  await writeFile(
    path.join(directory, "build-info.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
