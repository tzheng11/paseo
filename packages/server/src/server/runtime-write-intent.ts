import { randomUUID } from "node:crypto";
import { openSync, readFileSync, writeFileSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { open, readFile, mkdir } from "node:fs/promises";
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
  try {
    return RuntimeWriteIntentSchema.parse(
      JSON.parse(readFileSync(path.join(home, RUNTIME_WRITE_INTENT_FILENAME), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Persist before custom bootstrap or supported config writes; never reset a home or infer operation completion. */
export function ensureRuntimeWriteIntent(home: string): RuntimeWriteIntent {
  const existing = readRuntimeWriteIntent(home);
  if (existing) return existing;
  const record = createIntent(readRuntimeBuildIdentity());
  mkdirSync(home, { recursive: true });
  let fd: number;
  try {
    fd = openSync(path.join(home, RUNTIME_WRITE_INTENT_FILENAME), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = readRuntimeWriteIntent(home);
    if (!concurrent) throw new Error("Runtime write intent disappeared", { cause: error });
    return concurrent;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    const directory = openSync(home, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  return record;
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
  try {
    return RuntimeWriteIntentSchema.parse(
      JSON.parse(await readFile(path.join(home, RUNTIME_WRITE_INTENT_FILENAME), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function ensureRuntimeWriteIntentAsync(home: string): Promise<RuntimeWriteIntent> {
  const existing = await readIntentAsync(home);
  if (existing) return existing;
  const record = createIntent(await readRuntimeBuildIdentityAsync());
  await mkdir(home, { recursive: true });
  let fd;
  try {
    fd = await open(path.join(home, RUNTIME_WRITE_INTENT_FILENAME), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = await readIntentAsync(home);
    if (!concurrent) throw new Error("Runtime write intent disappeared", { cause: error });
    return concurrent;
  }
  try {
    await fd.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  return record;
}

export async function prepareRuntimeProvenance(home: string, daemonVersion: string) {
  const runtimeBuild = await readRuntimeBuildIdentityAsync();
  if (runtimeBuild && runtimeBuild.distributionVersion !== daemonVersion)
    throw new Error("Runtime build identity version mismatch");
  return { runtimeBuild, runtimeWriteIntent: await ensureRuntimeWriteIntentAsync(home) };
}
