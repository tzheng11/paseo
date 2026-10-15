import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { setWorkspaceFieldValue } from "./workspace-fields.js";

let directory: string;
let registry: FileBackedWorkspaceRegistry;
let writes: number;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-fields-"));
  writes = 0;
  registry = new FileBackedWorkspaceRegistry(
    path.join(directory, "workspaces.json"),
    createTestLogger(),
    {
      writeRecords: async (file, records) => {
        writes++;
        await writeJsonFileAtomic(file, records);
      },
    },
  );
  for (const workspaceId of ["A", "B", "C"]) {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project",
        cwd: workspaceId === "C" ? "/A" : `/${workspaceId}`,
        kind: "worktree",
        displayName: "main",
        title: "Title",
        branch: "feature",
        pinnedAt: "2026-10-14",
        createdAt: "2026-10-14",
        updatedAt: "2026-10-14",
      }),
    );
  }
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const save = (fieldKey: string, value: string, expectedValue = "", workspaceId = "A") =>
  setWorkspaceFieldValue(registry, { workspaceId, fieldKey, value, expectedValue });

test("real JSON reload preserves metadata and isolates workspace identity, including shared cwd", async () => {
  await save("notionProjectUrl", "project\nURL");
  await save("notionIssueUrl", "issue");
  const reloaded = new FileBackedWorkspaceRegistry(
    path.join(directory, "workspaces.json"),
    createTestLogger(),
  );
  expect(await reloaded.get("A")).toMatchObject({
    fieldValues: { notionProjectUrl: "project\nURL", notionIssueUrl: "issue" },
    cwd: "/A",
    title: "Title",
    branch: "feature",
    pinnedAt: "2026-10-14",
  });
  expect((await reloaded.get("B"))?.fieldValues).toBeUndefined();
  expect((await reloaded.get("C"))?.fieldValues).toBeUndefined();
  await save("notionIssueUrl", "", "issue");
  expect((await registry.get("A"))?.fieldValues?.notionProjectUrl).toBe("project\nURL");
});

test("lost acknowledgement retry makes no additional write; divergent edits conflict", async () => {
  await save("notionProjectUrl", "one");
  const committedWrites = writes;
  await save("notionProjectUrl", "one");
  expect(writes).toBe(committedWrites);
  await save("notionProjectUrl", "two", "one");
  await expect(save("notionProjectUrl", "one")).rejects.toMatchObject({ code: "conflict" });
  expect((await registry.get("A"))?.fieldValues?.notionProjectUrl).toBe("two");
});

test("serialized different-key edits merge and preserve future stored keys", async () => {
  await registry.update("A", (record) => ({ ...record, fieldValues: { futureField: "keep" } }));
  await Promise.all([save("notionProjectUrl", "project"), save("notionIssueUrl", "issue")]);
  expect((await registry.get("A"))?.fieldValues).toEqual({
    futureField: "keep",
    notionProjectUrl: "project",
    notionIssueUrl: "issue",
  });
});

test("invalid targets and limits fail before committing any data", async () => {
  const before = await readFile(path.join(directory, "workspaces.json"), "utf8");
  await expect(save("__proto__", "bad")).rejects.toMatchObject({ code: "unknown_field" });
  await expect(save("notionProjectUrl", "bad", "", "missing")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(save("notionProjectUrl", "a".repeat(8001))).rejects.toMatchObject({
    code: "invalid_value",
  });
  expect(await readFile(path.join(directory, "workspaces.json"), "utf8")).toBe(before);
  await save("notionProjectUrl", "☃".repeat(8000));
  const bounded = await readFile(path.join(directory, "workspaces.json"), "utf8");
  await expect(save("notionIssueUrl", "☃".repeat(8000))).rejects.toMatchObject({
    code: "invalid_value",
  });
  expect(await readFile(path.join(directory, "workspaces.json"), "utf8")).toBe(bounded);
  await registry.archive("A", "2026-10-15");
  const archived = await readFile(path.join(directory, "workspaces.json"), "utf8");
  await expect(save("notionIssueUrl", "bad")).rejects.toMatchObject({ code: "not_found" });
  expect(await readFile(path.join(directory, "workspaces.json"), "utf8")).toBe(archived);
});
