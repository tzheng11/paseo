import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaseoConfigForEdit } from "./paseo-config-file.js";

const fsControl = vi.hoisted(() => ({
  opens: 0,
  stall: false,
  stalled: [] as Array<() => void>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = (...args) => {
    fsControl.opens++;
    return actual.open(...args);
  };
  const stat = ((...args: Parameters<typeof actual.stat>) => {
    if (!fsControl.stall) return actual.stat(...args);
    return new Promise((resolve) => fsControl.stalled.push(() => resolve(actual.stat(...args))));
  }) as typeof actual.stat;
  return { ...actual, open, stat };
});

function releaseStalledStats(): void {
  fsControl.stall = false;
  for (const release of fsControl.stalled.splice(0)) release();
}

describe("project config snapshots", () => {
  let tempDir: string;

  function createRoots(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
      const root = mkdtempSync(join(tempDir, `root-${index}-`));
      writeFileSync(join(root, "paseo.json"), `${JSON.stringify({ scripts: {} })}\n`);
      return root;
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-config-snapshots-"));
    fsControl.opens = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    releaseStalledStats();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps a snapshot for every root a large host lists", async () => {
    const roots = createRoots(400);
    for (const root of roots) await readPaseoConfigForEdit(root);
    fsControl.opens = 0;

    for (const root of roots) {
      expect(await readPaseoConfigForEdit(root)).toMatchObject({ ok: true });
    }

    expect(fsControl.opens).toBe(0);
  });

  it("answers from the last snapshot when a read waits past its limit", async () => {
    const [known, unknown] = createRoots(2);
    const first = await readPaseoConfigForEdit(known!);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fsControl.stall = true;

    const knownRead = readPaseoConfigForEdit(known!);
    const unknownRead = readPaseoConfigForEdit(unknown!);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(first).toMatchObject({ ok: true, config: { scripts: {} } });
    expect(await knownRead).toEqual(first);
    expect(await unknownRead).toEqual({ ok: false, error: { code: "invalid_project_config" } });
  });
});
