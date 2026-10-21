import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, expect } from "vitest";
import { readClaudeHistoryRecords } from "./history-records.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function transcript(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-history-records-"));
  directories.push(directory);
  const filePath = path.join(directory, "history.jsonl");
  await writeFile(filePath, contents);
  return filePath;
}

test("an empty regular transcript has no history records", async () => {
  const filePath = await transcript("");
  const records = readClaudeHistoryRecords(filePath, new AbortController().signal);
  expect(await records.next()).toEqual({ done: true, value: undefined });
});

test("a directory transcript is rejected before the empty-file fast path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-history-directory-"));
  directories.push(directory);
  const filePath = path.join(directory, "history.jsonl");
  await mkdir(filePath);
  const records = readClaudeHistoryRecords(filePath, new AbortController().signal);
  await expect(records.next()).rejects.toMatchObject({
    code: "EISDIR",
    path: filePath,
    message: expect.stringContaining("EISDIR"),
  });
});

test("a symbolic link to a regular transcript preserves its history", async () => {
  const filePath = await transcript('{"message":"linked"}\n');
  const linkedPath = path.join(path.dirname(filePath), "linked-history.jsonl");
  await symlink(filePath, linkedPath, "file");
  const records = readClaudeHistoryRecords(linkedPath, new AbortController().signal);
  expect(await records.next()).toEqual({ done: false, value: { message: "linked" } });
  expect(await records.next()).toEqual({ done: true, value: undefined });
});

test("streamed history preserves valid CRLF and unterminated rows while skipping partial writes", async () => {
  const filePath = await transcript(
    '{"message":"first"}\r\n{partial\r\nnull\r\n[]\r\n{"message":"last"}',
  );
  const records = [];
  for await (const record of readClaudeHistoryRecords(filePath, new AbortController().signal))
    records.push(record);
  expect(records).toEqual([{ message: "first" }, { message: "last" }]);
});

test("a transcript append cannot extend an in-progress history read", async () => {
  const filePath = await transcript('{"message":"first"}\n{"message":"last"}\n');
  const records = readClaudeHistoryRecords(filePath, new AbortController().signal);
  expect(await records.next()).toEqual({ done: false, value: { message: "first" } });
  await appendFile(filePath, '{"message":"later"}\n');
  expect(await records.next()).toEqual({ done: false, value: { message: "last" } });
  expect(await records.next()).toEqual({ done: true, value: undefined });
});

test("cancelling history stops buffered rows and settles its stream", async () => {
  const filePath = await transcript('{"message":"first"}\n{"message":"last"}\n');
  const controller = new AbortController();
  const records = readClaudeHistoryRecords(filePath, controller.signal);
  expect(await records.next()).toEqual({ done: false, value: { message: "first" } });
  controller.abort(new Error("History cancelled"));
  await expect(records.next()).rejects.toThrow("History cancelled");
  expect(await records.next()).toEqual({ done: true, value: undefined });
});
