import { mkdir, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { persistedHistoryPaths } from "./persisted-history-paths.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function home() {
  const p = await mkdtemp(path.join(tmpdir(), "retained-history-"));
  dirs.push(p);
  return p;
}
function record(cwd: string, provider = "pi"): StoredAgentRecord {
  return {
    id: "retained-agent",
    provider,
    cwd,
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    labels: {},
    lastStatus: "closed",
    archivedAt: "2026-11-21T00:00:01Z",
    persistence: { provider, sessionId: "stored-id" },
  };
}

test("RECLAIM HISTORY retains every duplicate durable record and cached history reference", async () => {
  const root = await home();
  const storage = new AgentStorage(root, pino({ level: "silent" }));
  const current = {
    ...record(root),
    persistence: {
      provider: "pi",
      sessionId: "id",
      nativeHandle: path.join(root, "current.jsonl"),
    },
  };
  await storage.upsert(current);
  const stale = {
    ...current,
    persistence: { ...current.persistence, nativeHandle: path.join(root, "older.jsonl") },
  };
  await mkdir(path.join(root, "leftover"));
  await writeFile(path.join(root, "leftover", "duplicate.json"), JSON.stringify(stale));
  expect(await storage.retainedHistoryPaths()).toEqual(
    expect.arrayContaining([current.persistence.nativeHandle, stale.persistence.nativeHandle]),
  );
});

test("RECLAIM HISTORY reads fresh durable paths and refuses corrupt evidence", async () => {
  const root = await home();
  const storage = new AgentStorage(root, pino({ level: "silent" }));
  await storage.initialize();
  const durable = {
    ...record(root),
    persistence: { provider: "pi", sessionId: "id", nativeHandle: path.join(root, "late.jsonl") },
  };
  await writeFile(path.join(root, "late.json"), JSON.stringify(durable));
  expect(await storage.retainedHistoryPaths()).toContain(durable.persistence.nativeHandle);
  await writeFile(path.join(root, "corrupt.json"), "not JSON");
  await expect(storage.retainedHistoryPaths()).rejects.toThrow();
});

test("RECLAIM HISTORY resolves known tilde paths and refuses unverifiable relative paths", async () => {
  const root = await home();
  const r = record(root);
  r.persistence!.metadata = { history_path: "~/retained.jsonl" };
  expect(await persistedHistoryPaths([r], { homeDir: root, env: {} })).toContain(
    path.join(root, "retained.jsonl"),
  );
  r.persistence!.metadata = { historyPath: "unverified-relative.jsonl" };
  await expect(persistedHistoryPaths([r], { homeDir: root, env: {} })).rejects.toThrow(
    "reclaim_history_inventory_unverified",
  );
});

test("RECLAIM HISTORY includes moved Claude transcripts, sidechains and configured Codex stores", async () => {
  const root = await home();
  const projects = path.join(root, ".claude", "projects", "old-checkout");
  await mkdir(projects, { recursive: true });
  const transcript = path.join(projects, "stored-id.jsonl");
  await writeFile(transcript, "synthetic retained file");
  const paths = await persistedHistoryPaths([record(root, "claude"), record(root, "codex")], {
    homeDir: root,
    env: { CODEX_SQLITE_HOME: path.join(root, "native-index") },
  });
  expect(paths).toEqual(
    expect.arrayContaining([
      transcript,
      path.join(projects, "stored-id", "subagents"),
      path.join(root, "native-index", "thread_history_1.sqlite"),
    ]),
  );
  expect(paths).not.toContain(path.join(root, "stored-id"));
});

test("RECLAIM HISTORY keeps a symlink path instead of reading transcript contents", async () => {
  const root = await home();
  const transcript = path.join(root, "payload.jsonl");
  await writeFile(transcript, "fixture transcript");
  const alias = path.join(root, "alias.jsonl");
  await symlink(transcript, alias);
  const r = record(root);
  r.persistence!.nativeHandle = alias;
  expect(await persistedHistoryPaths([r], { homeDir: root, env: {} })).toContain(alias);
});
