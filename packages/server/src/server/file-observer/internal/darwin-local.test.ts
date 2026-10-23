import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { NativeWatchHost, type HostedNativeWatch } from "./native-watch-client.js";

const roots: string[] = [];
const watches: HostedNativeWatch[] = [];
afterEach(async () => {
  await Promise.all(watches.splice(0).map((watch) => watch.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hostWithBackend(backend: string, stderr: string[] = []) {
  return new NativeWatchHost({
    fork: (entry, args, options) => {
      const child = fork(entry, args, {
        ...options,
        env: { ...process.env, PASEO_DARWIN_WATCH_BACKEND: backend },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr!.on("data", (data: Buffer) => stderr.push(data.toString()));
      return child;
    },
  });
}

describe.skipIf(process.platform !== "darwin")("Node Darwin child backend", () => {
  test("delivers metadata and nested edits, excludes noise before IPC, and awaits close", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-node-watch-"));
    roots.push(root);
    const ignored = join(root, "node_modules");
    await Promise.all([
      mkdir(join(root, ".git")),
      mkdir(join(root, "src")),
      mkdir(join(ignored, "package"), { recursive: true }),
    ]);
    const paths = [join(".git", "HEAD"), join(".git", "index"), join("src", "probe.txt")];
    await Promise.all(paths.map((path) => writeFile(join(root, path), "before")));
    const host = hostWithBackend("node");
    const events: Array<string | null> = [];
    const watch = host.watch({ root, kind: "parcel", ignored: [ignored] }, (_, name) =>
      events.push(name),
    );
    watches.push(watch);
    await watch.ready;
    await Promise.all([
      ...paths.map((path) => writeFile(join(root, path), "after")),
      ...Array.from({ length: 100 }, (_, i) =>
        writeFile(join(ignored, "package", `${i}.txt`), "noise"),
      ),
    ]);
    await expect.poll(() => events).toEqual(expect.arrayContaining(paths));
    // NativeWatchHost forwards child events without an exclusion filter, so
    // ignored paths absent here were removed before the child's IPC queue.
    expect(events.filter((name) => name?.startsWith(`node_modules/`))).toEqual([]);
    const replacementEvents: Array<string | null> = [];
    const replacement = host.watch(
      { root, kind: "parcel", ignored: [ignored, join(root, "src")] },
      (_, name) => replacementEvents.push(name),
    );
    watches.push(replacement);
    await replacement.ready;
    // Match updateIgnore's replacement-before-close order, then use an event
    // through the replacement as the barrier for checking late old callbacks.
    await watch.close();
    const closedCount = events.length;
    await Promise.all([
      writeFile(join(root, "src", "probe.txt"), "now ignored"),
      writeFile(join(root, ".git", "HEAD"), "replacement"),
    ]);
    await expect.poll(() => replacementEvents.includes(join(".git", "HEAD"))).toBe(true);
    expect(replacementEvents.filter((name) => name?.startsWith("src/"))).toEqual([]);
    expect(events).toHaveLength(closedCount);
    await rm(root, { recursive: true, force: true });
    await replacement.close();
  });
});

test("the native child rejects an invalid backend before becoming ready", async () => {
  const errors: string[] = [];
  const host = hostWithBackend("automatic", errors);
  const watch = host.watch({ root: tmpdir(), kind: "parcel", ignored: [] }, () => undefined);
  watches.push(watch);
  await expect(watch.ready).rejects.toThrow(/exited/);
  await watch.close();
  expect(errors.join("")).toContain("PASEO_DARWIN_WATCH_BACKEND must be parcel or node");
});
