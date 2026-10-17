import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ReloadOperationStore } from "./reload-operation-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reload-receipt-"));
  directories.push(directory);
  return { directory, store: new ReloadOperationStore(directory, createTestLogger()) };
}
function receiptPath(directory: string, operationId: string) {
  return join(directory, `${createHash("sha256").update(operationId).digest("hex")}.json`);
}

test("lost acknowledgements and concurrent retries dispatch once after durable admission", async () => {
  const { directory, store } = await fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(async () => {
    expect(JSON.parse(await readFile(receiptPath(directory, "op"), "utf8"))).toMatchObject({
      status: "pending",
    });
    await gate;
  });
  const operations = await Promise.all([
    store.start("agent", "op", run),
    store.start("agent", "op", run),
  ]);
  expect(operations.map((operation) => operation.status)).toEqual(["pending", "pending"]);
  expect(run).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(async () =>
    expect(await store.get("op")).toMatchObject({ status: "completed" }),
  );
  expect(await store.start("agent", "op", run)).toMatchObject({ status: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  await expect(store.start("other-agent", "op", run)).rejects.toThrow("conflict");
});

test("restart preserves an uncertain operation and cannot repeat its close", async () => {
  const { directory, store } = await fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await store.start("agent", "op", () => gate);
  const restarted = new ReloadOperationStore(directory, createTestLogger());
  const run = vi.fn();
  expect(await restarted.start("agent", "op", run)).toMatchObject({
    status: "unknown",
    reasonCode: "DAEMON_RESTARTED",
    retryable: false,
  });
  expect(run).not.toHaveBeenCalled();
  // A stopped daemon cannot finish; release this fixture's callback only for teardown.
  finish();
  await vi.waitFor(async () =>
    expect(await store.get("op")).toMatchObject({ status: "completed" }),
  );
});

test("only absent receipts are NOT_FOUND; corrupt or mismatched receipts fail closed", async () => {
  const { directory, store } = await fixture();
  expect(await store.get("absent")).toBeNull();
  await writeFile(receiptPath(directory, "op"), "bad json");
  const run = vi.fn();
  await expect(store.start("agent", "op", run)).rejects.toThrow();
  await expect(store.get("op")).rejects.toThrow();
  await writeFile(
    receiptPath(directory, "op"),
    JSON.stringify({ operationId: "wrong", agentId: "agent", status: "completed" }),
  );
  await expect(store.get("op")).rejects.toThrow("identity mismatch");
  expect(run).not.toHaveBeenCalled();
});

test("admission storage failure never dispatches a reload", async () => {
  const { directory } = await fixture();
  const blocked = join(directory, "file");
  await writeFile(blocked, "not a directory");
  const store = new ReloadOperationStore(blocked, createTestLogger());
  const run = vi.fn();
  await expect(store.start("agent", "op", run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

test("busy refusal is terminal and replaying the same intent never dispatches again", async () => {
  const { store } = await fixture();
  const run = vi.fn(async () => {
    throw Object.assign(new Error("busy"), { code: "agent_reload_busy" });
  });
  await store.start("agent", "op", run);
  await vi.waitFor(async () =>
    expect(await store.get("op")).toMatchObject({
      status: "refused",
      reasonCode: "AGENT_RELOAD_BUSY",
      retryable: true,
    }),
  );
  await store.start("agent", "op", run);
  expect(run).toHaveBeenCalledTimes(1);
});

test.each([
  "reload_cleanup_unconfirmed",
  "reload_startup_unconfirmed",
  "reload_registration_unconfirmed",
])("%s holds the durable intent instead of permitting another spawn", async (code) => {
  const { store } = await fixture();
  const run = vi.fn(async () => {
    throw Object.assign(new Error("child did not exit"), { code });
  });
  await store.start("agent", "op", run);
  await vi.waitFor(async () =>
    expect(await store.get("op")).toMatchObject({
      status: "unknown",
      reasonCode: code.toUpperCase(),
      retryable: false,
    }),
  );
  await store.start("agent", "op", run);
  expect(run).toHaveBeenCalledTimes(1);
});
