import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  RuntimeBuildIdentitySchema,
  type RuntimeBuildIdentity,
} from "@getpaseo/protocol/runtime-build";

/** The packager seals this generated file with the compiled runtime, never a host environment override. */
export function readRuntimeBuildIdentity(
  url = new URL("./impower-build.json", import.meta.url),
): RuntimeBuildIdentity | undefined {
  let raw: string;
  try {
    raw = readFileSync(url, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseRuntimeBuildIdentity(raw);
}

export async function readRuntimeBuildIdentityAsync(
  url = new URL("./impower-build.json", import.meta.url),
): Promise<RuntimeBuildIdentity | undefined> {
  try {
    return parseRuntimeBuildIdentity(await readFile(url, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseRuntimeBuildIdentity(raw: string): RuntimeBuildIdentity {
  const build = RuntimeBuildIdentitySchema.parse(JSON.parse(raw));
  const { buildId } = build;
  // This is the schemaVersion 1 wire digest order, independent of Zod's field
  // declaration order. Keep the producer and consumer parity fixture in sync.
  const payload = {
    schemaVersion: build.schemaVersion,
    distributionVersion: build.distributionVersion,
    upstreamVersion: build.upstreamVersion,
    upstreamCommit: build.upstreamCommit,
    sourceCommit: build.sourceCommit,
    sourceTree: build.sourceTree,
    sourceDirty: build.sourceDirty,
    lockSha256: build.lockSha256,
  };
  const actual = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (buildId !== actual) throw new Error("Runtime build identity digest mismatch");
  return build;
}
