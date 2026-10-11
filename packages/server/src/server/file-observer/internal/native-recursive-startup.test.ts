import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createObserverPaths } from "./paths.js";

const scan = vi.hoisted(() => ({
  root: "",
  children: new Set<string>(),
  gate: Promise.resolve(),
  active: 0,
  peak: 0,
  failSibling: false,
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const path = String(args[0]);
      if (path !== scan.root && path.startsWith(`${scan.root}/`)) {
        const first = scan.children.size === 0;
        scan.children.add(path);
        if (scan.failSibling && scan.children.size === 2) {
          throw Object.assign(new Error("inventory permission failure"), { code: "EACCES" });
        }
        scan.active += 1;
        scan.peak = Math.max(scan.peak, scan.active);
        try {
          if (first) await scan.gate;
          return await fs.readdir(...args);
        } finally {
          scan.active -= 1;
        }
      }
      return fs.readdir(...args);
    },
  };
});

test.each([false, true])(
  "startup reads proceed concurrently and drain before returning (sibling failure: %s)",
  async (failSibling) => {
    const root = await mkdtemp(join(tmpdir(), "native-startup-inventory-"));
    scan.root = root;
    scan.children.clear();
    scan.active = 0;
    scan.peak = 0;
    scan.failSibling = failSibling;
    let release!: () => void;
    scan.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Promise.all(
      Array.from({ length: 32 }, async (_, i) => {
        const directory = join(root, `package-${i}`);
        await mkdir(directory);
        await writeFile(join(directory, "tracked.ts"), "export const value = 1;\n");
      }),
    );
    const paths = createObserverPaths(process.platform);
    const observer = createFileObserver();
    let active = true;
    const backend = createNativeRecursiveBackend(
      {
        root,
        metrics: observer.getDiagnostics(),
        isActive: () => active,
        isIgnored: () => false,
        isPathInside: paths.isInside,
        queueEvent: () => {},
        fail: (error) => {
          throw error;
        },
      },
      paths,
      () => ({ close: () => {}, on: () => {} }),
    );
    let settled = false;
    const starting = backend.start().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await expect.poll(() => scan.children.size).toBeGreaterThanOrEqual(8);
      expect(scan.peak).toBeLessThanOrEqual(16);
      expect(settled).toBe(false);
      release();
      const error = await starting;
      if (failSibling) expect(error).toMatchObject({ code: "EACCES" });
      else {
        expect(error).toBeNull();
        expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(32);
      }
    } finally {
      release();
      await starting;
      active = false;
      await backend.close();
      await observer.close();
      await rm(root, { recursive: true, force: true });
      scan.root = "";
    }
  },
);
