import { createHash } from "node:crypto";
import { open, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_LAYOUT_MODE_FILENAME,
  WorkspaceLayoutHomeMarkerSchema,
  WorkspaceLayoutConfigSchema,
  type WorkspaceLayoutConfig,
} from "@getpaseo/protocol/workspace-layout";
import { canonicalLayoutJson, WorkspaceLayoutRefusal } from "./workspace-layout-store.js";

export function assertWorkspaceLayoutAuthentication(
  mode: WorkspaceLayoutConfig | undefined,
  passwordHash: string | undefined,
): void {
  if (
    mode?.role === "authority" &&
    (!passwordHash || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash))
  )
    throw new WorkspaceLayoutRefusal("authority_password_protection_required");
}

/** An authority never negotiates the legacy relay security mode, including after config reload. */
export function requiresWorkspaceLayoutProtectedRelay(
  mode: WorkspaceLayoutConfig | undefined,
  configured: boolean | undefined,
): boolean {
  return mode?.role === "authority" || configured === true;
}

export async function assertWorkspaceRetirementAllowed(home: string): Promise<void> {
  if (await readMarker(path.join(home, WORKSPACE_LAYOUT_MODE_FILENAME)))
    throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  // The config declaration protects the interval before first canonical boot.
  // Parse failures are failures, never proof that this is an unconfigured home.
  try {
    const config: unknown = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new WorkspaceLayoutRefusal("config_unreadable");
    if (Object.hasOwn(config, "workspaceLayout"))
      throw new WorkspaceLayoutRefusal("canonical_retirement_reservation_required");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A sticky fail-closed retirement signal, not a freshness proof or a metadata authority. */
export async function resolveWorkspaceLayoutMode(
  home: string,
  configured: WorkspaceLayoutConfig | undefined,
): Promise<WorkspaceLayoutConfig | undefined> {
  const file = path.join(home, WORKSPACE_LAYOUT_MODE_FILENAME);
  const previous = await readMarker(file);
  if (previous) {
    const { schemaVersion: _version, destructiveRetirement: _retirement, ...mode } = previous;
    if (configured && canonicalLayoutJson(mode) !== canonicalLayoutJson(configured))
      throw new WorkspaceLayoutRefusal("home_authority_binding_changed");
    // Removing a config key must not silently re-enable independent local writers.
    return mode;
  }
  if (!configured) return undefined;
  const mode = WorkspaceLayoutConfigSchema.parse(configured);
  await mkdir(home, { recursive: true });
  let descriptor;
  try {
    descriptor = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return resolveWorkspaceLayoutMode(home, configured);
  }
  try {
    await descriptor.writeFile(
      JSON.stringify({ schemaVersion: 1, ...mode, destructiveRetirement: "refuse" }),
    );
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  return mode;
}

async function readMarker(file: string) {
  try {
    return WorkspaceLayoutHomeMarkerSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export async function prepareWorkspaceLayoutMode(
  home: string,
  configured: WorkspaceLayoutConfig | undefined,
  auth: { password?: string } | undefined,
) {
  const mode = await resolveWorkspaceLayoutMode(home, configured);
  assertWorkspaceLayoutAuthentication(mode, auth?.password);
  return mode;
}

export function assertWorkspaceLayoutAuthorityKey(
  mode: WorkspaceLayoutConfig | undefined,
  publicKeyB64: string,
): void {
  if (
    mode?.role === "authority" &&
    createHash("sha256").update(publicKeyB64).digest("hex") !== mode.authorityKeySha256
  )
    throw new WorkspaceLayoutRefusal("authority_key_mismatch");
}
