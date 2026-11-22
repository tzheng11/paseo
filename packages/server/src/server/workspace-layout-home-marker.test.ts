import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveWorkspaceLayoutMode } from "./workspace-layout-mode.js";
import { promoteWorkspaceLayoutHomeMarker } from "./workspace-layout-home-marker.js";
import * as atomicFile from "./atomic-file.js";

const homes: string[] = [];
const config = {
  role: "authority" as const,
  authorityServerId: "owner",
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
  authorityKeySha256: "a".repeat(64),
  semanticsVersion: 2 as const,
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-marker-promotion-"));
  homes.push(home);
  await resolveWorkspaceLayoutMode(home, config);
  const file = path.join(home, "workspace-layout-mode.json");
  return { home, file, marker: async () => JSON.parse(await readFile(file, "utf8")) };
}

test("RECLAIM marker promotions serialize the latest read and never lower the version", async () => {
  const f = await fixture();
  const original = atomicFile.writeFileDurably;
  let release!: () => void, entered!: () => void;
  const pause = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const write = vi.spyOn(atomicFile, "writeFileDurably").mockImplementation(async (...args) => {
    entered();
    await pause;
    return original(...args);
  });
  const first = promoteWorkspaceLayoutHomeMarker(f.home, config, 4);
  await started;
  const second = promoteWorkspaceLayoutHomeMarker(f.home, config, 3);
  release();
  await Promise.all([first, second]);
  expect(write).toHaveBeenCalledTimes(1);
  expect(await f.marker()).toEqual({
    ...config,
    schemaVersion: 4,
    destructiveRetirement: "refuse",
  });
});

test("RECLAIM marker promotion failure releases its lock and queue", async () => {
  const f = await fixture();
  vi.spyOn(atomicFile, "writeFileDurably").mockRejectedValueOnce(new Error("owned write failure"));
  await expect(promoteWorkspaceLayoutHomeMarker(f.home, config, 4)).rejects.toThrow(
    "owned write failure",
  );
  expect((await f.marker()).schemaVersion).toBe(2);
  await promoteWorkspaceLayoutHomeMarker(f.home, config, 3);
  expect((await f.marker()).schemaVersion).toBe(3);
});

test("RECLAIM marker promotion refuses another process's lock without changing its marker", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  await mkdir(`${f.file}.lock`);
  await expect(promoteWorkspaceLayoutHomeMarker(f.home, config, 4)).rejects.toThrow(
    "home_marker_busy",
  );
  expect(await readFile(f.file, "utf8")).toBe(before);
});

test.each(["missing", "malformed", "binding"])(
  "RECLAIM marker promotion refuses %s evidence without replacing it",
  async (kind) => {
    const f = await fixture();
    if (kind === "missing") await rm(f.file);
    if (kind === "malformed") await writeFile(f.file, "unparseable");
    if (kind === "binding")
      await writeFile(
        f.file,
        JSON.stringify({ ...(await f.marker()), epoch: "00000000-0000-4000-8000-000000000003" }),
      );
    const before = kind === "missing" ? null : await readFile(f.file, "utf8");
    await expect(promoteWorkspaceLayoutHomeMarker(f.home, config, 4)).rejects.toThrow();
    if (kind === "missing")
      await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(f.file, "utf8")).toBe(before);
    await expect(readFile(`${f.file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
