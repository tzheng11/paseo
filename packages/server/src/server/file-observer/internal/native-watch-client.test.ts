import { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { NativeWatchHost, type HostedNativeWatch } from "./native-watch-client.js";

const roots: string[] = [];
const watches: HostedNativeWatch[] = [];
afterEach(async () => {
  await Promise.all(watches.splice(0).map((watch) => watch.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode: string, timeout = 5000) {
  const root = await mkdtemp(join(tmpdir(), "paseo-host-test-"));
  roots.push(root);
  const entry = join(root, "host.mjs");
  await writeFile(
    entry,
    `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const roots = new Map();
    const block = root => {
      writeFileSync(join(root, 'entered'), '1');
      const end = Date.now() + 8000;
      while (!existsSync(join(root, 'release')) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    };
    process.on('message', command => {
      if (command.action === 'watch') {
        roots.set(command.id, command.input.root);
        if (${JSON.stringify(mode)} === 'watch') block(command.input.root);
        if (${JSON.stringify(mode)} === 'exit') process.exit(17);
        process.send({action:'ready', id:command.id});
      } else {
        if (${JSON.stringify(mode)} === 'close') block(roots.get(command.id));
        process.send({action:'events', id:command.id, events:[['change','late']]});
        process.send({action:'closed', id:command.id});
      }
    });
    process.on('disconnect', () => process.exit(0));
  `,
  );
  return { root, host: new NativeWatchHost({ entry: pathToFileURL(entry), timeoutMs: timeout }) };
}

async function entered(root: string) {
  await expect
    .poll(async () => {
      try {
        await access(join(root, "entered"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
}

for (const mode of ["watch", "close"]) {
  test(`daemon can run callbacks while native ${mode} is synchronously blocked`, async () => {
    const { root, host } = await fixture(mode);
    const events: string[] = [];
    const watch = host.watch({ root, kind: "directory" }, (_, filename) => events.push(filename!));
    watches.push(watch);
    const barrier = mode === "watch" ? watch.ready : watch.ready.then(() => watch.close());
    let settled = false;
    void barrier.then(() => {
      settled = true;
      return undefined;
    });
    await entered(root);
    // Release comes from the daemon thread, after it proves it can still run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await writeFile(join(root, "release"), "1");
    await barrier;
    await watch.close();
    expect(events).toEqual([]); // Already-closing subscriptions suppress late IPC.
  });
}

test("cancelled registration remains an awaited native cleanup barrier", async () => {
  const { root, host } = await fixture("watch");
  const watch = host.watch({ root, kind: "directory" }, () => {
    throw Error("late event");
  });
  watches.push(watch);
  await entered(root);
  const closed = watch.close();
  let settled = false;
  void closed.then(() => {
    settled = true;
    return undefined;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  await writeFile(join(root, "release"), "1");
  await closed;
});

test("a stuck native call times out, closes its process, and can register again", async () => {
  const { root, host } = await fixture("watch", 1000);
  const watch = host.watch({ root, kind: "directory" }, () => undefined);
  watches.push(watch);
  const rejection = expect(watch.ready).rejects.toThrow("timed out");
  await entered(root);
  await rejection;
  await watch.close();
  await writeFile(join(root, "release"), "1");
  const replacement = host.watch({ root, kind: "directory" }, () => undefined);
  watches.push(replacement);
  await replacement.ready;
  await replacement.close();
});

test("host exit reports failure to every observation and releases close barriers", async () => {
  const { root, host } = await fixture("exit");
  const watch = host.watch({ root, kind: "directory" }, () => undefined);
  watches.push(watch);
  await expect(watch.ready).rejects.toThrow("exited (17)");
  await watch.close();
});

test("failed child spawn without an exit event releases every close barrier", async () => {
  const child = new ChildProcess();
  child.send = () => true;
  child.kill = () => false;
  const host = new NativeWatchHost({ fork: () => child });
  // Node can return a ChildProcess with no pid when spawn fails with EMFILE.
  // No native process exists to kill and no exit event follows the error.
  const watch = host.watch({ root: "/not-spawned", kind: "directory" }, () => undefined);
  watches.push(watch);
  queueMicrotask(() =>
    child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })),
  );
  await expect(watch.ready).rejects.toThrow("spawn EMFILE");
  await watch.close();
  expect(child.pid).toBeUndefined();
});
