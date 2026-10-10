import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createOrganizerMcpServer } from "./server";
import { organizationSchema, type Organization } from "../../shared/organization";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  let values: Organization = { nodes: [] };
  let revision = "0";
  let conflictOnWrite = false;
  const server = createOrganizerMcpServer(async (method, raw) => {
    if (method === "settings.organization.read") return { status: "ready", values, revision };
    const input = raw as { revision: string; values: unknown };
    if (conflictOnWrite || input.revision !== revision)
      return { status: "conflict", error: "Changed while saving" };
    values = organizationSchema.parse(input.values);
    revision = String(Number(revision) + 1);
    return { status: "saved", values, revision };
  });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    return {
      ...result,
      data: result.structuredContent as { status: string; revision: string; values: Organization },
    };
  };
  return {
    client,
    call,
    current: () => ({ values, revision }),
    race: () => {
      conflictOnWrite = true;
    },
  };
}
describe("pinned folder MCP protocol", () => {
  it("lists eight tools and manages folders, remote workspace references and named links", async () => {
    const api = await setup();
    expect((await api.client.listTools()).tools).toHaveLength(8);
    const original = await api.call("list_pinned_folders");
    expect(original.data).toMatchObject({ status: "ready", revision: "0", values: { nodes: [] } });
    await api.call("create_pinned_folder", { revision: "0", title: "Projects" });
    const folder = api.current().values.nodes[0];
    await api.call("create_pinned_folder", {
      revision: "1",
      title: "Development",
      parentId: folder.id,
    });
    const child = api.current().values.nodes[1];
    await api.call("pin_workspace", {
      revision: "2",
      title: "Remote",
      parentId: child.id,
      serverId: "Laptop",
      workspaceId: "real-workspace",
    });
    const workspace = api.current().values.nodes[2];
    await api.call("rename_pinned_entry", { revision: "3", id: workspace.id, title: "Work" });
    await api.call("set_pinned_project_link", {
      revision: "4",
      id: workspace.id,
      title: "Notion",
      url: "https://www.notion.so/project",
    });
    const link = api.current().values.nodes[2].links[0];
    await api.call("set_pinned_project_link", {
      revision: "5",
      id: workspace.id,
      linkId: link.id,
      title: "Project",
      url: "https://www.notion.so/updated",
    });
    expect(api.current().values.nodes[2].links[0]).toEqual({
      ...link,
      title: "Project",
      url: "https://www.notion.so/updated",
    });
    await api.call("move_pinned_entry", {
      revision: "6",
      id: workspace.id,
      parentId: null,
      beforeId: folder.id,
    });
    expect(
      api
        .current()
        .values.nodes.filter((node) => node.parentId === null)
        .map((node) => node.id),
    ).toEqual([workspace.id, folder.id]);
    await api.call("remove_pinned_project_link", {
      revision: "7",
      id: workspace.id,
      linkId: link.id,
    });
    expect(api.current().values.nodes.find((node) => node.id === workspace.id)?.links).toEqual([]);
    await api.call("remove_pinned_entry", { revision: "8", id: folder.id });
    expect(api.current().values.nodes.find((node) => node.id === child.id)?.parentId).toBeNull();
    expect(api.current().values.nodes.find((node) => node.id === workspace.id)).toMatchObject({
      serverId: "Laptop",
      workspaceId: "real-workspace",
      title: "Work",
    });
  });
  it("rejects stale revisions and a race between reading and writing", async () => {
    const api = await setup();
    await api.call("create_pinned_folder", { revision: "0", title: "Keep" });
    const stale = await api.call("create_pinned_folder", { revision: "0", title: "Stale" });
    expect(stale.isError).toBe(true);
    expect(stale.data.status).toBe("conflict");
    api.race();
    const raced = await api.call("create_pinned_folder", { revision: "1", title: "Raced" });
    expect(raced.isError).toBe(true);
    expect(raced.data.status).toBe("conflict");
    expect(api.current().values.nodes.map((node) => node.title)).toEqual(["Keep"]);
  });
  it("rejects cycles, duplicate workspace tuples, workspace parents and unsafe links without writes", async () => {
    const api = await setup();
    await api.call("create_pinned_folder", { revision: "0", title: "Folder" });
    const folder = api.current().values.nodes[0];
    await api.call("pin_workspace", {
      revision: "1",
      title: "Work",
      serverId: "host",
      workspaceId: "wks",
      parentId: folder.id,
    });
    const workspace = api.current().values.nodes[1];
    for (const [tool, args] of [
      ["move_pinned_entry", { id: folder.id, parentId: folder.id }],
      ["create_pinned_folder", { title: "Invalid", parentId: workspace.id }],
      ["pin_workspace", { title: "Duplicate", serverId: "host", workspaceId: "wks" }],
      [
        "set_pinned_project_link",
        { id: workspace.id, title: "Unsafe", url: "javascript:alert(1)" },
      ],
      ["remove_pinned_project_link", { id: workspace.id, linkId: "missing" }],
    ] as const)
      expect((await api.call(tool, { revision: "2", ...args })).isError).toBe(true);
    expect(api.current().revision).toBe("2");
    expect(api.current().values.nodes).toHaveLength(2);
  });
});
