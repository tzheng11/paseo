import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ensureRuntimeWriteIntent,
  ensureRuntimeWriteIntentAsync,
  readRuntimeWriteIntent,
  RUNTIME_WRITE_INTENT_FILENAME,
} from "./runtime-write-intent.js";
import {
  readPersistedConfig,
  savePersistedConfig,
  savePersistedConfigAsync,
} from "./persisted-config.js";
import { WorkspaceLayoutStore } from "./workspace-layout-store.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "runtime-write-intent-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("the first supported write persists a private stable generation before later config writes", async () => {
  expect(readRuntimeWriteIntent(home)).toBeUndefined();
  savePersistedConfig(home, { version: 1, agents: { resumeOnStartup: false } });
  const first = ensureRuntimeWriteIntent(home);
  expect(first).toMatchObject({
    formatFamily: "paseo-impower-015",
    minimumRecoveryVersion: "0.15.0-impower",
    firstWriter: { version: "0.15.0-impower", build: null },
  });
  await savePersistedConfigAsync(home, {
    version: 1,
    agents: { resumeOnStartup: true, resumePrompt: "Resume carefully" },
  });
  expect(ensureRuntimeWriteIntent(home)).toEqual(first);
  if (process.platform !== "win32")
    expect((await stat(path.join(home, RUNTIME_WRITE_INTENT_FILENAME))).mode & 0o777).toBe(0o600);
});

test("read-only and rejected config operations never create a write intent", () => {
  expect(readPersistedConfig(home)).toEqual({});
  expect(readRuntimeWriteIntent(home)).toBeUndefined();
  expect(() => savePersistedConfig(home, { version: 99 } as never)).toThrow("Invalid config");
  expect(readRuntimeWriteIntent(home)).toBeUndefined();
});

test("async runtime config initialization yields before disk IO instead of using the synchronous startup port", async () => {
  const saved = savePersistedConfigAsync(home, { version: 1 });
  expect(readRuntimeWriteIntent(home)).toBeUndefined();
  await saved;
  expect(readRuntimeWriteIntent(home)?.formatFamily).toBe("paseo-impower-015");
});

test("a damaged or newer marker refuses before any supported config write instead of resetting its generation", async () => {
  await writeFile(path.join(home, "config.json"), '{"version":1}');
  const file = path.join(home, RUNTIME_WRITE_INTENT_FILENAME);
  for (const bytes of ['{"schemaVersion":2}', "{broken"]) {
    await writeFile(file, bytes);
    expect(() =>
      savePersistedConfig(home, { version: 1, agents: { resumeOnStartup: true } }),
    ).toThrow("runtime-write-intent.json");
    await expect(savePersistedConfigAsync(home, { version: 1 })).rejects.toThrow(
      "runtime-write-intent.json",
    );
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe('{"version":1}');
  }
});

test("concurrent first writers publish only a complete marker and retain the winning generation", async () => {
  const intents = await Promise.all(
    Array.from({ length: 30 }, () => ensureRuntimeWriteIntentAsync(home)),
  );
  expect(new Set(intents.map((intent) => intent.generation)).size).toBe(1);
  expect(readRuntimeWriteIntent(home)).toEqual(intents[0]);
  expect(ensureRuntimeWriteIntent(home)).toEqual(intents[0]);
  expect(await readdir(home)).toEqual([RUNTIME_WRITE_INTENT_FILENAME]);
  // A create-only publication hard link must be retired before returning.
  expect((await stat(path.join(home, RUNTIME_WRITE_INTENT_FILENAME))).nlink).toBe(1);
});

test("fresh 015 source readers preserve new config and canonical writes on the current home without snapshot restoration", async () => {
  const identity = { authorityServerId: "srv_hub", authorityId: randomUUID(), epoch: randomUUID() };
  const config = {
    version: 1 as const,
    workspaceLayout: {
      ...identity,
      role: "authority" as const,
      authorityKeySha256: "a".repeat(64),
    },
    agents: { resumeOnStartup: true, resumePrompt: "Keep current work" },
    daemon: { usage: { enabled: false } },
  };
  savePersistedConfig(home, config);
  const generation = ensureRuntimeWriteIntent(home);
  const writer = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
  const initial = await writer.initialize(identity);
  await writer.commit({
    requestId: "current-write",
    expected: initial.stamp,
    mutations: [
      {
        kind: "import-host",
        previousSourceSha256: null,
        source: {
          serverId: "srv_a",
          sourceSha256: "b".repeat(64),
          resolutionSha256: "c".repeat(64),
        },
        entries: [
          {
            ref: { serverId: "srv_a", workspaceId: "one" },
            projectId: "project",
            pinnedAt: "2026-11-04T10:00:00.000Z",
            superpinnedAt: "2026-11-04T10:00:00.000Z",
            parent: null,
            siblingOrder: 0,
            pinPlacement: null,
            archivedAt: null,
            revision: 0,
          },
        ],
      },
    ],
  });
  const after = await writer.inspect();
  const reader = new WorkspaceLayoutStore({ paseoHome: home, identity, serverId: "srv_hub" });
  expect(readPersistedConfig(home)).toEqual(config);
  expect(await reader.inspect()).toEqual(after);
  expect(readRuntimeWriteIntent(home)).toEqual(generation);
});
