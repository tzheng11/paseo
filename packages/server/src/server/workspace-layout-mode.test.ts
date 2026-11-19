import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  resolveWorkspaceLayoutMode,
  assertWorkspaceRetirementAllowed,
  assertWorkspaceLayoutAuthentication,
  requiresWorkspaceLayoutProtectedRelay,
} from "./workspace-layout-mode.js";

let home: string;
const mode = {
  role: "replica" as const,
  authorityServerId: "srv_hub",
  authorityKeySha256: "a".repeat(64),
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paseo-layout-mode-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it("does not enable canonical mode on an unconfigured legacy home", async () => {
  expect(await resolveWorkspaceLayoutMode(home, undefined)).toBeUndefined();
  await expect(readFile(path.join(home, "workspace-layout-mode.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("requires protected relay admission for an authority despite an unset or disabled legacy flag", () => {
  for (const configured of [undefined, false, true]) {
    expect(requiresWorkspaceLayoutProtectedRelay({ ...mode, role: "authority" }, configured)).toBe(
      true,
    );
  }
  expect(requiresWorkspaceLayoutProtectedRelay(mode, false)).toBe(false);
  expect(requiresWorkspaceLayoutProtectedRelay(undefined, true)).toBe(true);
});

it("refuses a publicly reachable canonical authority without configured password verification", () => {
  const authority = { ...mode, role: "authority" as const };
  for (const hash of [undefined, "", "not-a-verifier"])
    expect(() => assertWorkspaceLayoutAuthentication(authority, hash)).toThrow(
      "authority_password_protection_required",
    );
  expect(() => assertWorkspaceLayoutAuthentication(mode, undefined)).not.toThrow();
  expect(() =>
    assertWorkspaceLayoutAuthentication(authority, `$2b$12$${"a".repeat(53)}`),
  ).not.toThrow();
});
it("keeps canonical retirement protection and identity after removal of the config key", async () => {
  expect(await resolveWorkspaceLayoutMode(home, mode)).toEqual(mode);
  expect(await resolveWorkspaceLayoutMode(home, undefined)).toEqual(mode);
  expect(JSON.parse(await readFile(path.join(home, "workspace-layout-mode.json"), "utf8"))).toEqual(
    { schemaVersion: 1, ...mode, destructiveRetirement: "refuse" },
  );
});
it("refuses a changed identity/epoch/role instead of rebinding a home silently", async () => {
  await resolveWorkspaceLayoutMode(home, mode);
  for (const changed of [
    { ...mode, authorityServerId: "srv_other" },
    { ...mode, epoch: "00000000-0000-4000-8000-000000000003" },
    { ...mode, role: "authority" as const },
  ])
    await expect(resolveWorkspaceLayoutMode(home, changed)).rejects.toThrow(
      "home_authority_binding_changed",
    );
  expect(await resolveWorkspaceLayoutMode(home, undefined)).toEqual(mode);
});
it("refuses unreadable or malformed protection instead of treating it as a legacy home", async () => {
  await writeFile(path.join(home, "workspace-layout-mode.json"), "{broken");
  await expect(resolveWorkspaceLayoutMode(home, undefined)).rejects.toThrow();
});

it("blocks destructive retirement on either the declaration or sticky marker, without an age heuristic", async () => {
  await expect(assertWorkspaceRetirementAllowed(home)).resolves.toBeUndefined();
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ version: 1, workspaceLayout: mode }),
  );
  await expect(assertWorkspaceRetirementAllowed(home)).rejects.toThrow(
    "canonical_retirement_reservation_required",
  );
  await resolveWorkspaceLayoutMode(home, mode);
  await rm(path.join(home, "config.json"));
  await expect(assertWorkspaceRetirementAllowed(home)).rejects.toThrow(
    "canonical_retirement_reservation_required",
  );
  await writeFile(path.join(home, "workspace-layout-mode.json"), "{broken");
  await expect(assertWorkspaceRetirementAllowed(home)).rejects.toThrow();
});
