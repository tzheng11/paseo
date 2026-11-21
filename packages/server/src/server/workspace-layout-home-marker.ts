import { mkdir, readFile, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_LAYOUT_MODE_FILENAME,
  WorkspaceLayoutHomeMarkerSchema,
  type WorkspaceLayoutConfig,
} from "@getpaseo/protocol/workspace-layout";
import { writeFileDurably } from "./atomic-file.js";
import { canonicalLayoutJson, WorkspaceLayoutRefusal } from "./workspace-layout-store.js";

const promotions = new Map<string, Promise<void>>();

/** A short marker-only critical section, independent of the backing operation's lifetime. */
export async function promoteWorkspaceLayoutHomeMarker(
  home: string,
  config: WorkspaceLayoutConfig,
  minimumVersion: 3 | 4,
): Promise<void> {
  const file = path.join(await realpath(home), WORKSPACE_LAYOUT_MODE_FILENAME);
  const previous = promotions.get(file) ?? Promise.resolve();
  async function promote(): Promise<void> {
    // Also refuse competing processes. A stale lock requires reconciliation, never a downgrade.
    const lock = `${file}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new WorkspaceLayoutRefusal("home_marker_busy");
      throw error;
    }
    try {
      const marker = WorkspaceLayoutHomeMarkerSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
      const { schemaVersion, destructiveRetirement: _retirement, ...bound } = marker;
      if (canonicalLayoutJson(bound) !== canonicalLayoutJson(config))
        throw new WorkspaceLayoutRefusal("home_authority_binding_changed");
      if (schemaVersion >= minimumVersion) return;
      const promoted = WorkspaceLayoutHomeMarkerSchema.parse({
        ...marker,
        schemaVersion: minimumVersion,
      });
      await writeFileDurably(file, JSON.stringify(promoted));
    } finally {
      await rmdir(lock);
    }
  }
  const result = previous.then(promote);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  promotions.set(file, settled);
  try {
    await result;
  } finally {
    if (promotions.get(file) === settled) promotions.delete(file);
  }
}
