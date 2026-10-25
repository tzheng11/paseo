import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeFileAtomic } from "./atomic-file.js";
import { MessageReceipts } from "./message-receipts/index.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalRename = fs.rename.bind(fs);
const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "atomic-file-test-"));
  directories.push(directory);
  return directory;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

test("retries a Windows receipt commit without resending or replacing its pending receipt early", async () => {
  const directory = await createDirectory();
  setPlatform("win32");
  vi.useFakeTimers();
  const firstFailure = Promise.withResolvers<void>();
  const completedAttempts: string[] = [];
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    const receipt = JSON.parse(await fs.readFile(from, "utf8"));
    if (receipt.state === "completed") {
      completedAttempts.push(String(from));
      if (completedAttempts.length <= 2) {
        firstFailure.resolve();
        throw Object.assign(new Error("Transient Windows sharing conflict"), {
          code: completedAttempts.length === 1 ? "EPERM" : "EBUSY",
        });
      }
    }
    await originalRename(from, to);
  });
  const receipts = new MessageReceipts(directory);
  const send = vi.fn(async () => undefined);
  let settled = false;
  const delivery = receipts
    .send({ agentId: "agent", messageId: "message", request: { text: "hello" }, send })
    .finally(() => {
      settled = true;
    });
  const outcome = delivery.catch((error: unknown) => error);
  await firstFailure.promise;
  await vi.advanceTimersByTimeAsync(0);
  const receiptName = (await fs.readdir(directory)).find((name) => name.endsWith(".json"));
  const receiptPath = path.join(directory, receiptName!);
  const pendingBytes = await fs.readFile(receiptPath, "utf8");
  expect(JSON.parse(pendingBytes).state).toBe("pending");
  expect(send).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(9);
  expect(completedAttempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await fs.readFile(receiptPath, "utf8")).toBe(pendingBytes);
  await vi.advanceTimersByTimeAsync(20);
  expect(await outcome).toBeUndefined();
  expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).state).toBe("completed");
  expect(new Set(completedAttempts).size).toBe(1);
  expect(completedAttempts).toHaveLength(3);
  expect(rename).toHaveBeenCalledTimes(4);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(directory)).toEqual([receiptName]);
});

test("bounds a permanent Windows commit failure and leaves its pending receipt authoritative", async () => {
  const directory = await createDirectory();
  setPlatform("win32");
  vi.useFakeTimers();
  const failures = Array.from({ length: 6 }, () => Promise.withResolvers<void>());
  const completedAttempts: string[] = [];
  const error = Object.assign(new Error("Persistent sharing conflict"), { code: "EPERM" });
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    const receipt = JSON.parse(await fs.readFile(from, "utf8"));
    if (receipt.state === "completed") {
      completedAttempts.push(String(from));
      failures[completedAttempts.length - 1]!.resolve();
      throw error;
    }
    await originalRename(from, to);
  });
  const receipts = new MessageReceipts(directory);
  const send = vi.fn(async () => undefined);
  const input = { agentId: "agent", messageId: "message", request: { text: "hello" }, send };
  const outcome = receipts.send(input).catch((failure: unknown) => failure);
  await failures[0]!.promise;
  await vi.advanceTimersByTimeAsync(0);
  const receiptName = (await fs.readdir(directory)).find((name) => name.endsWith(".json"));
  const receiptPath = path.join(directory, receiptName!);
  const pendingBytes = await fs.readFile(receiptPath, "utf8");
  for (const [index, delay] of [10, 20, 40, 80, 160].entries()) {
    await vi.advanceTimersByTimeAsync(delay);
    await failures[index + 1]!.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(await fs.readFile(receiptPath, "utf8")).toBe(pendingBytes);
  }
  expect(await outcome).toBe(error);
  expect(completedAttempts).toHaveLength(6);
  expect(new Set(completedAttempts).size).toBe(1);
  expect(await fs.readdir(directory)).toEqual([receiptName]);
  await expect(receipts.send(input)).rejects.toThrow("agent_request_outcome_unknown");
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  ["darwin", "EPERM"],
  ["darwin", "EBUSY"],
  ["linux", "EPERM"],
  ["linux", "EBUSY"],
  ["win32", "EACCES"],
  ["win32", "EIO"],
] as const)(
  "keeps %s %s failures immediate and preserves the old destination",
  async (platform, code) => {
    const directory = await createDirectory();
    const destination = path.join(directory, "record.json");
    await fs.writeFile(destination, "old contents");
    setPlatform(platform);
    vi.useFakeTimers();
    const attempted = Promise.withResolvers<void>();
    const error = Object.assign(new Error("Rename failed"), { code });
    const rename = vi.spyOn(fs, "rename").mockImplementation(async () => {
      attempted.resolve();
      throw error;
    });
    const outcome = writeFileAtomic(destination, "replacement").catch(
      (failure: unknown) => failure,
    );
    await attempted.promise;
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(error);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(destination, "utf8")).toBe("old contents");
    expect(await fs.readdir(directory)).toEqual(["record.json"]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
