import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModule = "packages/server/dist/server/server/agent/providers/opencode/bridge.js";

// Mirrors nix/package.nix's installPhase: copy every traced path into $out.
async function installTracedDaemon(outRoot) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(repoRoot, "scripts/trace-daemon.mjs")],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const file of stdout.split("\n").filter(Boolean)) {
    await cp(path.join(repoRoot, file), path.join(outRoot, file), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

test("traced daemon closure ships the OpenCode bridge plugin for every OpenCode version", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    await installTracedDaemon(outRoot);
    const indexPath = "packages/server/dist/server/server/agent/providers/codex/history-index.js";
    const { readCodexHistoryIndex } = await import(
      pathToFileURL(path.join(outRoot, indexPath)).href
    );
    const databasePath = path.join(outRoot, "history-fixture.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE thread_items (
      thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
      updated_at_ordinal INTEGER, item_type TEXT, item_json TEXT
    ); INSERT INTO thread_items VALUES ('owned', 'turn', 'prompt', 1, 1, 'userMessage', '{}');`);
    database.close();
    const history = await readCodexHistoryIndex({
      databasePath,
      threadId: "owned",
      operation: "messages",
    });
    assert.equal(history.totalEvents, 1);
    assert.equal(history.messages[0].itemId, "prompt");
    const installedBridgeUrl = pathToFileURL(path.join(outRoot, bridgeModule)).href;
    const { loadOpenCodeBridgePluginArtifact } = await import(installedBridgeUrl);

    for (const version of [1, 2]) {
      const artifact = await loadOpenCodeBridgePluginArtifact(
        installedBridgeUrl,
        undefined,
        version,
      );
      assert.ok(artifact.byteLength > 0, `OpenCode v${version} bridge plugin is empty`);
    }
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});
