import { randomUUID } from "node:crypto";
import {
  openSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  mkdirSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { open, readFile, mkdir, link, unlink } from "node:fs/promises";
import path from "node:path";
import {
  RuntimeWriteIntentSchema,
  type RuntimeWriteIntent,
} from "@getpaseo/protocol/runtime-build";
import { readRuntimeBuildIdentity, readRuntimeBuildIdentityAsync } from "./runtime-build.js";
import type { RuntimeBuildIdentity } from "@getpaseo/protocol/runtime-build";
import { resolveDaemonVersion } from "./daemon-version.js";

export const RUNTIME_WRITE_INTENT_FILENAME = "runtime-write-intent.json";

/** A positive, conservative write boundary. Absence never proves that stock/other writers did nothing. */
export function readRuntimeWriteIntent(home: string): RuntimeWriteIntent | undefined {
  const file = path.join(home, RUNTIME_WRITE_INTENT_FILENAME);
  try {
    return RuntimeWriteIntentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read runtime write-intent marker: ${file}`, { cause: error });
  }
}

/** Persist before custom bootstrap or supported config writes; never reset a home or infer operation completion. */
export function ensureRuntimeWriteIntent(home: string): RuntimeWriteIntent {
  const existing = readRuntimeWriteIntent(home);
  if (existing) {
    syncDirectory(home);
    return existing;
  }
  const record = createIntent(readRuntimeBuildIdentity());
  mkdirSync(home, { recursive: true });
  const temporary = path.join(home, `.${RUNTIME_WRITE_INTENT_FILENAME}.${randomUUID()}.tmp`);
  let result = record;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // Publish complete bytes atomically, without replacing another writer.
      linkSync(temporary, path.join(home, RUNTIME_WRITE_INTENT_FILENAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = readRuntimeWriteIntent(home);
      if (!concurrent) throw new Error("Runtime write intent disappeared", { cause: error });
      result = concurrent;
    }
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(home);
  return result;
}

function syncDirectory(home: string): void {
  if (process.platform !== "win32") {
    const directory = openSync(home, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

function createIntent(build: RuntimeBuildIdentity | undefined): RuntimeWriteIntent {
  return {
    schemaVersion: 1,
    formatFamily: "paseo-impower-015",
    minimumRecoveryVersion: "0.15.0-impower",
    generation: randomUUID(),
    firstIntentAt: new Date().toISOString(),
    firstWriter: {
      version: resolveDaemonVersion(import.meta.url),
      build: build ?? null,
    },
  };
}

async function readIntentAsync(home: string): Promise<RuntimeWriteIntent | undefined> {
  const file = path.join(home, RUNTIME_WRITE_INTENT_FILENAME);
  try {
    return RuntimeWriteIntentSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read runtime write-intent marker: ${file}`, { cause: error });
  }
}

export async function ensureRuntimeWriteIntentAsync(home: string): Promise<RuntimeWriteIntent> {
  const existing = await readIntentAsync(home);
  if (existing) {
    await syncDirectoryAsync(home);
    return existing;
  }
  const record = createIntent(await readRuntimeBuildIdentityAsync());
  await mkdir(home, { recursive: true });
  const temporary = path.join(home, `.${RUNTIME_WRITE_INTENT_FILENAME}.${randomUUID()}.tmp`);
  let result = record;
  const fd = await open(temporary, "wx", 0o600);
  try {
    try {
      await fd.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await link(temporary, path.join(home, RUNTIME_WRITE_INTENT_FILENAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await readIntentAsync(home);
      if (!concurrent) throw new Error("Runtime write intent disappeared", { cause: error });
      result = concurrent;
    }
  } finally {
    await unlink(temporary);
  }
  await syncDirectoryAsync(home);
  return result;
}

async function syncDirectoryAsync(home: string): Promise<void> {
  if (process.platform !== "win32") {
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export async function prepareRuntimeProvenance(home: string, daemonVersion: string) {
  const runtimeBuild = await readRuntimeBuildIdentityAsync();
  if (runtimeBuild && runtimeBuild.distributionVersion !== daemonVersion)
    throw new Error("Runtime build identity version mismatch");
  return { runtimeBuild, runtimeWriteIntent: await ensureRuntimeWriteIntentAsync(home) };
}
