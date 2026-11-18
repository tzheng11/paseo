import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const exec = promisify(execFile);
const packages = ["cli", "client", "highlight", "plugin", "protocol", "relay", "server"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Packet path escapes its root");
}
export async function packetEntries(root) {
  const entries = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative === "manifest.json") continue;
      const info = await lstat(file);
      const mode = `0o${(info.mode & 0o777).toString(8)}`;
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        if (path.isAbsolute(target)) throw new Error("Packet contains an absolute symlink");
        inside(root, path.resolve(path.dirname(file), target));
        entries.push({ path: relative, kind: "symlink", target, mode });
      } else if (info.isDirectory()) await walk(file);
      else if (info.isFile())
        entries.push({
          path: relative,
          kind: "file",
          sha256: await hashFile(file),
          bytes: info.size,
          mode,
        });
      else throw new Error(`Unsupported packet entry: ${relative}`);
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyPacket(root, manifest) {
  if (!Array.isArray(manifest.entries)) throw new Error("Packet manifest has no entries");
  const expected = new Map();
  for (const entry of manifest.entries) {
    if (
      !entry.path ||
      path.posix.normalize(entry.path) !== entry.path ||
      path.isAbsolute(entry.path) ||
      entry.path === "manifest.json"
    )
      throw new Error("Invalid manifest path");
    inside(root, path.resolve(root, entry.path));
    if (expected.has(entry.path)) throw new Error("Duplicate manifest entry");
    expected.set(entry.path, entry);
  }
  const actual = await packetEntries(root);
  if (actual.length !== expected.size)
    throw new Error("Packet inventory is incomplete or contains extra files");
  for (const entry of actual) {
    const original = expected.get(entry.path);
    if (!original || Object.entries(entry).some(([key, value]) => original[key] !== value))
      throw new Error(`Packet entry differs from manifest: ${entry.path}`);
  }
  return actual;
}
export function assertOverlayCompatibility(base, current) {
  if (
    base.packagingVersion !== 4 ||
    base.platform !== current.platform ||
    base.architecture !== current.architecture ||
    current.platform !== "darwin" ||
    current.architecture !== "arm64"
  )
    throw new Error("Overlay packet platform or format mismatch");
  if (base.lockSha256 !== current.lockSha256 || base.packageVersion !== current.packageVersion)
    throw new Error("Overlay dependency lock or package version mismatch");
  if (base.nodeSha256 !== current.nodeSha256 || !base.nodeVersion)
    throw new Error("Overlay Node binding mismatch");
}
export function assertFreshIdentity(identity, current) {
  if (
    !identity ||
    identity.sourceDirty !== false ||
    identity.sourceCommit !== current.sourceCommit ||
    identity.sourceTree !== current.sourceTree ||
    identity.lockSha256 !== current.lockSha256 ||
    identity.distributionVersion !== current.packageVersion
  )
    throw new Error("Fresh runtime output does not match the clean source identity");
  const { buildId, ...payload } = identity;
  if (sha(JSON.stringify(payload)) !== buildId)
    throw new Error("Fresh runtime build identity hash mismatch");
}
async function permissions(root, writable) {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await chmod(file, writable ? 0o755 : 0o555);
      await permissions(file, writable);
    } else if (!writable) await chmod(file, info.mode & 0o111 ? 0o555 : 0o444);
  }
}
async function command(program, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${program} exited ${code}`));
        return;
      }
      resolve();
    });
  });
}
async function verifyWeb(directory, current) {
  const bytes = await readFile(path.join(directory, "build-info.json"));
  const info = JSON.parse(bytes);
  if (
    info.sourceDirty !== false ||
    info.sourceCommit !== current.sourceCommit ||
    info.sourceTree !== current.sourceTree ||
    info.lockSha256 !== current.lockSha256
  )
    throw new Error("Fresh browser output has the wrong source identity");
  for (const file of info.files) {
    inside(directory, path.resolve(directory, file.path));
    const raw = await readFile(path.join(directory, file.path));
    if (sha(raw) !== file.sha256 || raw.length !== file.bytes)
      throw new Error(`Browser asset mismatch: ${file.path}`);
    for (const [extension, decompress] of [
      [".gz", gunzipSync],
      [".br", brotliDecompressSync],
    ]) {
      const compressed = await readFile(path.join(directory, `${file.path}${extension}`)).catch(
        (error) => {
          if (error.code === "ENOENT" && !/\.(html|js|css|json|svg|map)$/.test(file.path))
            return null;
          throw error;
        },
      );
      if (compressed && !decompress(compressed).equals(raw))
        throw new Error(`Compressed browser asset mismatch: ${file.path}${extension}`);
    }
  }
  return sha(bytes);
}

async function qualifyOverlaySource(options) {
  const repo = path.resolve(options.repo);
  const base = path.resolve(options.base);
  const git = async (...args) => (await exec("git", args, { cwd: repo })).stdout.trim();
  if (await git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error("Packet source must be clean");
  const commit = await git("rev-parse", "HEAD");
  if (commit !== options.commit) throw new Error("Packet source is not the requested exact commit");
  await git(
    "merge-base",
    "--is-ancestor",
    commit,
    options.integrationRef ?? "origin/work/paseo-014-upgrade",
  );
  const baseManifestBytes = await readFile(path.join(base, "manifest.json"));
  if (
    sha(baseManifestBytes) !== options.baseManifestSha256 ||
    (await hashFile(options.baseArchive)) !== options.baseArchiveSha256
  )
    throw new Error("Base archive or manifest trust anchor mismatch");
  const manifest = JSON.parse(baseManifestBytes);
  const archiveManifest = await exec(
    "tar",
    ["-xOzf", options.baseArchive, `paseo-${manifest.sourceCommit}-darwin-arm64/manifest.json`],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  if (sha(archiveManifest.stdout) !== options.baseManifestSha256)
    throw new Error("Base archive and directory are not the same packet");
  const baseEntries = await verifyPacket(base, manifest);
  const rootPackage = JSON.parse(await readFile(path.join(repo, "package.json")));
  const current = {
    sourceCommit: commit,
    sourceTree: await git("rev-parse", "HEAD^{tree}"),
    packageVersion: rootPackage.version,
    lockSha256: await hashFile(path.join(repo, "package-lock.json")),
    nodeSha256: await hashFile(path.join(base, "bin/node")),
    platform: process.platform,
    architecture: process.arch,
  };
  assertOverlayCompatibility(manifest, current);
  const node = path.join(base, "bin/node");
  const nodeFacts = JSON.parse(
    (
      await exec(node, [
        "-p",
        "JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})",
      ])
    ).stdout,
  );
  if (
    nodeFacts.version !== manifest.nodeVersion ||
    nodeFacts.abi !== process.versions.modules ||
    nodeFacts.platform !== current.platform ||
    nodeFacts.arch !== current.architecture
  )
    throw new Error("Build Node ABI or platform differs from the audited base");
  for (const file of [
    "package.json",
    "package-lock.json",
    "scripts/staged-runtime.py",
    ...packages.map((name) => `packages/${name}/package.json`),
  ]) {
    const original = await exec("git", ["show", `${manifest.sourceCommit}:${file}`], {
      cwd: repo,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (sha(original.stdout) !== (await hashFile(path.join(repo, file))))
      throw new Error(`Reused runtime input changed: ${file}`);
  }
  if (
    (await hashFile(path.join(repo, "scripts/staged-runtime.py"))) !==
    manifest.packagingPrimitivesSha256
  )
    throw new Error("Packet wrapper primitives changed");
  const runOptions = {
    cwd: repo,
    env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH}` },
  };
  return { repo, base, git, commit, manifest, baseEntries, current, node, nodeFacts, runOptions };
}

export async function verifyClosurePath(repo, runtime, relative) {
  inside(repo, path.resolve(repo, relative));
  const staged = path.join(runtime, relative);
  const original = await lstat(path.join(repo, relative));
  const copied = await lstat(staged);
  if (
    original.isFile() &&
    copied.isFile() &&
    (await hashFile(path.join(repo, relative))) !== (await hashFile(staged))
  )
    throw new Error(`Runtime dependency closure differs: ${relative}`);
  if (
    original.isFile() !== copied.isFile() ||
    original.isDirectory() !== copied.isDirectory() ||
    original.isSymbolicLink() !== copied.isSymbolicLink()
  )
    throw new Error(`Runtime dependency type differs: ${relative}`);
  if (
    original.isSymbolicLink() &&
    (await readlink(path.join(repo, relative))) !== (await readlink(staged))
  )
    throw new Error(`Runtime dependency link differs: ${relative}`);
  if (!original.isFile() && !original.isSymbolicLink() && !original.isDirectory())
    throw new Error(`Unqualified traced dependency: ${relative}`);
}

export async function buildOverlayPacket(options) {
  const { repo, base, git, commit, manifest, baseEntries, current, node, nodeFacts, runOptions } =
    await qualifyOverlaySource(options);
  for (const script of ["build:server:clean", "build:app-deps", "build:daemon-web-ui"])
    await command("npm", ["run", script], runOptions);
  if (await git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error("Fresh build changed tracked source; commit generated inputs before packaging");
  const provenancePath = "packages/server/dist/server/server/impower-build.json";
  const provenanceBytes = await readFile(path.join(repo, provenancePath));
  const identity = JSON.parse(provenanceBytes);
  assertFreshIdentity(identity, current);
  if (
    !(await readFile(path.join(repo, "packages/server/dist/src/server/impower-build.json"))).equals(
      provenanceBytes,
    )
  )
    throw new Error("The two generated runtime identities disagree");
  const traced = (
    await exec(node, ["scripts/trace-daemon.mjs"], { ...runOptions, maxBuffer: 20 * 1024 * 1024 })
  ).stdout
    .trim()
    .split("\n");
  const output = path.resolve(options.output);
  const packet = path.join(output, `paseo-${commit}-darwin-arm64`);
  const archive = `${packet}.tar.gz`;
  for (const file of [packet, archive]) {
    try {
      await lstat(file);
      throw new Error(`Output already exists: ${file}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(output, ".overlay-"));
  const stage = path.join(temporary, path.basename(packet));
  try {
    await cp(base, stage, { recursive: true, dereference: false, verbatimSymlinks: true });
    await chmod(stage, 0o755);
    await permissions(stage, true);
    const freshRoots = packages.map((name) => `runtime/packages/${name}/dist`);
    for (const name of packages) {
      const destination = path.join(stage, "runtime/packages", name, "dist");
      await rm(destination, { recursive: true, force: true });
      await cp(path.join(repo, "packages", name, "dist"), destination, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
    await rm(path.join(stage, "runtime/packages/server/dist/server/web-ui"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(stage, "web"), { recursive: true, force: true });
    await cp(path.join(repo, "packages/server/dist/server/web-ui"), path.join(stage, "web"), {
      recursive: true,
    });
    const browserProvenanceSha256 = await verifyWeb(path.join(stage, "web"), current);
    const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
    for (const relative of traced) {
      if (manifest.sourceCheckoutTraceExclusions?.includes(relative)) continue;
      inside(repo, path.resolve(repo, relative));
      await verifyClosurePath(repo, path.join(stage, "runtime"), relative);
    }
    await permissions(stage, false);
    const entries = await packetEntries(stage);
    const changed = entries
      .filter((entry) => JSON.stringify(entry) !== JSON.stringify(baseByPath.get(entry.path)))
      .map((entry) => entry.path);
    const removed = baseEntries
      .filter((entry) => !entries.some((next) => next.path === entry.path))
      .map((entry) => entry.path);
    if (
      [...changed, ...removed].some(
        (file) =>
          !freshRoots.some((root) => file.startsWith(`${root}/`)) && !file.startsWith("web/"),
      )
    )
      throw new Error("Overlay modified a reused runtime dependency");
    const result = {
      ...manifest,
      ...current,
      parents: (await git("show", "-s", "--format=%P", "HEAD")).split(" ").filter(Boolean),
      runtimeBuild: identity,
      runtimeBuildSha256: sha(provenanceBytes),
      browserProvenanceSha256,
      assemblerSha256: await hashFile(fileURLToPath(import.meta.url)),
      builtWithNode: nodeFacts.version,
      overlay: {
        baseArchiveSha256: options.baseArchiveSha256,
        baseManifestSha256: options.baseManifestSha256,
        baseSourceCommit: manifest.sourceCommit,
        nodeAbi: nodeFacts.abi,
        freshlyBuilt: [...freshRoots, "web"],
        changed,
        removed,
        reused: entries.filter((entry) => !changed.includes(entry.path)).map((entry) => entry.path),
        traceSha256: sha(traced.join("\n")),
      },
      entries,
    };
    await chmod(path.join(stage, "manifest.json"), 0o644);
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`);
    await chmod(path.join(stage, "manifest.json"), 0o444);
    await verifyPacket(stage, result);
    await rename(stage, packet);
    await exec("tar", ["-czf", `${archive}.partial`, "-C", output, path.basename(packet)]);
    await rename(`${archive}.partial`, archive);
    return {
      packet,
      archive,
      sha256: await hashFile(archive),
      manifestSha256: await hashFile(path.join(packet, "manifest.json")),
      sourceCommit: commit,
      sourceTree: current.sourceTree,
      buildId: identity.buildId,
      changed: changed.length,
      removed: removed.length,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  const names = {
    "--repo": "repo",
    "--base": "base",
    "--base-archive": "baseArchive",
    "--base-archive-sha256": "baseArchiveSha256",
    "--base-manifest-sha256": "baseManifestSha256",
    "--commit": "commit",
    "--output": "output",
    "--integration-ref": "integrationRef",
  };
  for (let index = 0; index < args.length; index += 2) {
    if (!names[args[index]] || !args[index + 1])
      throw new Error("Unknown or missing packet argument");
    options[names[args[index]]] = args[index + 1];
  }
  for (const field of [
    "repo",
    "base",
    "baseArchive",
    "baseArchiveSha256",
    "baseManifestSha256",
    "commit",
    "output",
  ])
    if (!options[field]) throw new Error(`Missing packet argument: ${field}`);
  console.log(JSON.stringify(await buildOverlayPacket(options), null, 2));
}
