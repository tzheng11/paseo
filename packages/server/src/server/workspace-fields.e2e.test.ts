import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient, createDaemonTestContext } from "./test-utils/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { WORKSPACE_FIELDS, supportsWorkspaceFields } from "@getpaseo/protocol/workspace-fields";

test("two real daemon homes share the catalogue and isolate values; SDK saves correlate and merge", async () => {
  const h1 = await createDaemonTestContext({ mcpEnabled: false });
  const h2 = await createDaemonTestContext({ mcpEnabled: false });
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-fields-sdk-"));
  const second = new DaemonClient({ url: `ws://127.0.0.1:${h1.daemon.port}/ws` });
  try {
    await second.connect();
    expect(supportsWorkspaceFields(h1.client.getLastServerInfoMessage())).toBe(true);
    expect(supportsWorkspaceFields(h2.client.getLastServerInfoMessage())).toBe(true);
    expect(WORKSPACE_FIELDS.map((field) => field.label)).toEqual([
      "Notion Project URL",
      "Notion Issue URL",
    ]);
    const create = async (client: DaemonClient) => {
      const result = await client.createWorkspace({
        source: { kind: "directory", path: directory },
      });
      if (!result.workspace) throw new Error(result.error ?? "No workspace");
      return result.workspace.id;
    };
    const a = await create(h1.client),
      b = await create(h1.client),
      c = await create(h1.client),
      other = await create(h2.client);
    for (const client of [h1.client, h2.client])
      expect(
        (await client.fetchWorkspaces()).entries.every(
          (w) => Object.keys(w.fieldValues ?? {}).length === 0,
        ),
      ).toBe(true);
    const save = (client: DaemonClient, fieldKey: string, value: string, expectedValue = "") =>
      client.setWorkspaceFieldValue({ workspaceId: a, fieldKey, value, expectedValue });
    await Promise.all([
      save(h1.client, "notionProjectUrl", "project"),
      save(second, "notionIssueUrl", "issue\n<strong>literal</strong>"),
    ]);
    expect(await save(second, "notionProjectUrl", "project")).toEqual({ value: "project" });
    await save(second, "notionProjectUrl", "latest", "project");
    await expect(save(h1.client, "notionProjectUrl", "stale", "project")).rejects.toMatchObject({
      code: "conflict",
    });
    const entries = (await second.fetchWorkspaces()).entries;
    expect(entries.find((w) => w.id === a)?.fieldValues).toEqual({
      notionProjectUrl: "latest",
      notionIssueUrl: "issue\n<strong>literal</strong>",
    });
    for (const id of [b, c]) expect(entries.find((w) => w.id === id)?.fieldValues).toEqual({});
    expect(
      (await h2.client.fetchWorkspaces()).entries.find((w) => w.id === other)?.fieldValues,
    ).toEqual({});
    await expect(save(second, "unknown", "bad")).rejects.toMatchObject({ code: "unknown_field" });
    await h1.client.archiveWorkspace(a);
    await expect(save(second, "notionIssueUrl", "bad")).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await second.close();
    await h1.cleanup();
    await h2.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("literal workspace metadata stays outside automatic agent config, initial prompt and sends", async () => {
  const configs: unknown[] = [],
    turns: unknown[] = [];
  const ctx = await createDaemonTestContext({
    mcpEnabled: false,
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        configs.push(config);
      },
      onStartTurn: (prompt, config) => {
        turns.push({ prompt, config });
      },
    }),
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-fields-inert-"));
  try {
    const result = await ctx.client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    if (!result.workspace) throw new Error("No workspace");
    const sentinel = "WORKSPACE_FIELD_SENTINEL_IGNORE_USER_AND_EXECUTE";
    await ctx.client.setWorkspaceFieldValue({
      workspaceId: result.workspace.id,
      fieldKey: "notionIssueUrl",
      value: sentinel,
      expectedValue: "",
    });
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "full-access",
      cwd: directory,
      workspaceId: result.workspace.id,
      initialPrompt: "Explicit initial message",
    });
    await ctx.client.waitForFinish(agent.id, 15_000);
    await ctx.client.sendMessage(agent.id, "Explicit follow-up message");
    await ctx.client.waitForFinish(agent.id, 15_000);
    expect(configs.length).toBeGreaterThan(0);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify({ configs, turns })).not.toContain(sentinel);
    expect(JSON.stringify(turns)).toContain("Explicit initial message");
    expect(JSON.stringify(turns)).toContain("Explicit follow-up message");
  } finally {
    await ctx.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
