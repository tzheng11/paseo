import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { webBuildManifest } from "./web-build-provenance.mjs";

test("web provenance follows HTML's active script and detects missing or substituted assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-web-provenance-"));
  try {
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/old.js"), "old build");
    await writeFile(path.join(root, "assets/active.js"), "active build");
    await writeFile(path.join(root, "build-info.json"), '{"scripts":["old.js"]}');
    await writeFile(
      path.join(root, "index.html"),
      '<script defer src="/assets/active.js"></script>',
    );
    const manifest = await webBuildManifest(root, { sourceCommit: "candidate" });
    assert.deepEqual(
      manifest.scripts.map((file) => file.path),
      ["assets/active.js"],
    );
    assert.equal(
      manifest.scripts[0].sha256,
      createHash("sha256").update("active build").digest("hex"),
    );
    assert.ok(!manifest.files.some((file) => file.path === "build-info.json"));
    await writeFile(path.join(root, "assets/active.js"), "changed bytes");
    assert.notEqual(
      (await webBuildManifest(root, {})).scripts[0].sha256,
      manifest.scripts[0].sha256,
    );
    await rm(path.join(root, "assets/active.js"));
    await assert.rejects(webBuildManifest(root, {}), /Export script is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
