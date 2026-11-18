import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  cp,
  readlink,
  chmod,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  packetEntries,
  verifyPacket,
  assertOverlayCompatibility,
  assertFreshIdentity,
  verifyClosurePath,
  setPacketPermissions,
  discardPacketStage,
  assertPacketDirectory,
  publishPacketStage,
} from "./build-overlay-packet.mjs";

async function fixture(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-overlay-test-"));
  try {
    await mkdir(path.join(root, "runtime/packages/example/dist"), { recursive: true });
    await writeFile(
      path.join(root, "runtime/packages/example/dist/entry.js"),
      "export const fixture = true;\n",
    );
    await mkdir(path.join(root, "runtime/node_modules"));
    await symlink("../packages/example", path.join(root, "runtime/node_modules/example"));
    const manifest = { entries: await packetEntries(root) };
    await action(root, manifest);
  } finally {
    await discardPacketStage(root);
  }
}

test("complete packet verification preserves qualified relative workspace links", async () => {
  await fixture(async (root, manifest) => {
    assert.deepEqual(await verifyPacket(root, manifest), manifest.entries);
    assert.equal(
      manifest.entries.find((entry) => entry.kind === "symlink").target,
      "../packages/example",
    );
  });
});
test("a tampered base payload fails even when its inventory path is unchanged", async () => {
  await fixture(async (root, manifest) => {
    await writeFile(path.join(root, "runtime/packages/example/dist/entry.js"), "different build\n");
    await assert.rejects(verifyPacket(root, manifest), /differs from manifest/);
  });
});
test("missing fresh output and unmanifested extra files both refuse", async () => {
  await fixture(async (root, manifest) => {
    await rm(path.join(root, "runtime/packages/example/dist/entry.js"));
    await assert.rejects(verifyPacket(root, manifest), /inventory is incomplete/);
    await writeFile(path.join(root, "unmanifested.js"), "unexpected\n");
    await assert.rejects(verifyPacket(root, manifest), /differs from manifest/);
  });
});
test("escaping and duplicate identities cannot be sealed into a packet", async () => {
  await fixture(async (root, manifest) => {
    await assert.rejects(
      verifyPacket(root, { entries: [...manifest.entries, manifest.entries[0]] }),
      /Duplicate manifest/,
    );
    await symlink("../../outside", path.join(root, "escape"));
    await assert.rejects(packetEntries(root), /escapes its root/);
  });
});
test("wrong platform, lock and Node bindings are refused independently", () => {
  const base = {
    packagingVersion: 4,
    platform: "darwin",
    architecture: "arm64",
    packageVersion: "fixture",
    lockSha256: "lock",
    nodeSha256: "node",
    nodeVersion: "v22.fixture",
  };
  assert.doesNotThrow(() => assertOverlayCompatibility(base, base));
  for (const changed of [
    { platform: "linux" },
    { architecture: "x64" },
    { lockSha256: "changed" },
    { nodeSha256: "changed" },
  ])
    assert.throws(() => assertOverlayCompatibility(base, { ...base, ...changed }), /mismatch/);
});
test("final identity must bind actual clean commit, tree and complete generated payload", () => {
  const payload = {
    schemaVersion: 1,
    distributionVersion: "fixture",
    upstreamVersion: "fixture",
    upstreamCommit: "upstream",
    sourceCommit: "commit",
    sourceTree: "tree",
    sourceDirty: false,
    lockSha256: "lock",
  };
  const identity = {
    ...payload,
    buildId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
  const current = {
    sourceCommit: "commit",
    sourceTree: "tree",
    packageVersion: "fixture",
    lockSha256: "lock",
  };
  assert.doesNotThrow(() => assertFreshIdentity(identity, current));
  for (const changed of [
    { sourceDirty: true },
    { sourceCommit: "old" },
    { sourceTree: "old" },
    { buildId: "copied" },
  ])
    assert.throws(() => assertFreshIdentity({ ...identity, ...changed }, current), /identity/);
  assert.throws(() => assertFreshIdentity(null, current), /output/);
});

test("overlay copying preserves base relative links and never references the installed packet", async () => {
  await fixture(async (root, manifest) => {
    const copied = `${root}-copied`;
    try {
      await cp(root, copied, { recursive: true, dereference: false, verbatimSymlinks: true });
      assert.equal(
        await readlink(path.join(copied, "runtime/node_modules/example")),
        "../packages/example",
      );
      assert.deepEqual(await verifyPacket(copied, manifest), manifest.entries);
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
  });
});

test("trace closure accepts directories and refuses mismatched types and link targets", async () => {
  await fixture(async (root) => {
    const copied = `${root}-closure`;
    try {
      await cp(root, copied, { recursive: true, dereference: false, verbatimSymlinks: true });
      await verifyClosurePath(root, copied, "runtime/packages/example/dist");
      await verifyClosurePath(root, copied, "runtime/node_modules/example");
      await rm(path.join(copied, "runtime/node_modules/example"));
      await symlink("../packages/other", path.join(copied, "runtime/node_modules/example"));
      await assert.rejects(
        verifyClosurePath(root, copied, "runtime/node_modules/example"),
        /link differs/,
      );
      await rm(path.join(copied, "runtime/packages/example/dist/entry.js"));
      await mkdir(path.join(copied, "runtime/packages/example/dist/entry.js"));
      await assert.rejects(
        verifyClosurePath(root, copied, "runtime/packages/example/dist/entry.js"),
        /type differs/,
      );
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
  });
});

test("sealing preserves audited read/execute bits and cleanup cannot mask the original failure", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "runtime/packages/example/dist/entry.js");
    await chmod(file, 0o554);
    const expected = await packetEntries(root);
    await setPacketPermissions(root, false);
    assert.equal((await lstat(file)).mode & 0o777, 0o554);
    assert.deepEqual(await verifyPacket(root, { entries: expected }), expected);
    await assert.rejects(async () => {
      try {
        throw new Error("original closure refusal");
      } finally {
        await discardPacketStage(root);
      }
    }, /original closure refusal/);
  });
});

test("sealed packets publish across parent directories and survive staging cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-overlay-publish-"));
  try {
    const temporary = path.join(root, "temporary");
    const stage = path.join(temporary, "packet");
    const published = path.join(root, "published");
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "payload.js"), "fixture\n");
    await chmod(path.join(stage, "payload.js"), 0o554);
    await setPacketPermissions(stage, false);
    const entries = await packetEntries(stage);
    await publishPacketStage(stage, published);
    assert.equal((await lstat(published)).mode & 0o777, 0o555);
    assert.equal((await lstat(path.join(published, "payload.js"))).mode & 0o777, 0o554);
    await discardPacketStage(temporary);
    assert.equal(await readFile(path.join(published, "payload.js"), "utf8"), "fixture\n");
    assert.deepEqual(await verifyPacket(published, { entries }), entries);
  } finally {
    await discardPacketStage(root);
  }
});

test("a symlink at the base or permission root refuses before the qualified tree can change", async () => {
  await fixture(async (root, manifest) => {
    const alias = `${root}-alias`;
    try {
      await symlink(root, alias);
      await assert.rejects(assertPacketDirectory(alias), /nonsymlink directory/);
      await assert.rejects(setPacketPermissions(alias, true), /nonsymlink directory/);
      assert.deepEqual(await verifyPacket(root, manifest), manifest.entries);
    } finally {
      await rm(alias, { force: true });
    }
  });
});
