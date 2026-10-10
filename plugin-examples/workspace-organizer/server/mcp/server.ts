import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { settingsRpc } from "@getpaseo/plugin";
import {
  newId,
  organizationSchema,
  projectLinkSchema,
  relocateNode,
  removeNode,
  updateNode,
  type Organization,
} from "../../shared/organization";

export type OrganizerRpc = (method: string, input: unknown) => Promise<unknown>;
const id = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(160);
const revision = z
  .string()
  .min(1)
  .describe(
    "Revision returned by list_pinned_folders. A stale revision is rejected; list again before retrying.",
  );
const parentId = id
  .nullable()
  .default(null)
  .describe("Folder ID, or null for the top level. Workspaces cannot contain entries.");
const beforeId = id
  .nullable()
  .default(null)
  .describe("Insert before this sibling ID; null appends to the destination.");
function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError } : {}),
  };
}

export function createOrganizerMcpServer(invoke: OrganizerRpc) {
  const server = new McpServer({ name: "paseo-organizer", version: "0.1.0" });
  const rpc = settingsRpc("organization");
  const read = async () => {
    const state = rpc.read.output.parse(await invoke("settings.organization.read", {}));
    if (state.status !== "ready") throw new Error(state.error);
    return { ...state, values: organizationSchema.parse(state.values) };
  };
  server.registerTool(
    "list_pinned_folders",
    {
      description:
        "Read Studio's shared pinned tree, project links and revision. Workspace references contain serverId/workspaceId; this does not list workspace execution or modify regular Paseo pins.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        return result(await read());
      } catch (error) {
        return result({ status: "error", error: String(error) }, true);
      }
    },
  );
  function mutation<Schema extends z.ZodObject>(
    name: string,
    description: string,
    schema: Schema,
    apply: (document: Organization, input: z.output<Schema>) => Organization,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: name === "remove_pinned_entry" || name === "remove_pinned_project_link",
        },
      },
      async (input) => {
        try {
          const args = schema.parse(input);
          const state = await read();
          if (args.revision !== state.revision)
            return result(
              {
                status: "conflict",
                error:
                  "Settings changed on another client. List the tree and retry with its current revision.",
                revision: state.revision,
              },
              true,
            );
          const values = organizationSchema.parse(apply(state.values, args));
          const saved = rpc.write.output.parse(
            await invoke("settings.organization.write", { revision: state.revision, values }),
          );
          return result(saved, saved.status !== "saved");
        } catch (error) {
          return result({ status: "error", error: String(error) }, true);
        }
      },
    );
  }
  mutation(
    "create_pinned_folder",
    "Create a shared folder. Returns the saved tree and its new revision.",
    z.object({ revision, title, parentId, beforeId }).strict(),
    (document, input) => {
      const node = {
        kind: "folder" as const,
        id: newId(),
        title: input.title,
        parentId: null,
        links: [],
      };
      return relocateNode(
        { nodes: [...document.nodes, node] },
        { id: node.id, parentId: input.parentId, beforeId: input.beforeId },
      );
    },
  );
  mutation(
    "pin_workspace",
    "Add an existing workspace reference from any host. Does not create, rename or move the actual workspace or change its regular pin. Use its real serverId/workspaceId.",
    z.object({ revision, title, serverId: id, workspaceId: id, parentId, beforeId }).strict(),
    (document, input) => {
      const node = {
        kind: "workspace" as const,
        id: newId(),
        parentId: null,
        title: input.title,
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        links: [],
      };
      return relocateNode(
        { nodes: [...document.nodes, node] },
        { id: node.id, parentId: input.parentId, beforeId: input.beforeId },
      );
    },
  );
  mutation(
    "rename_pinned_entry",
    "Rename a folder or the display label of a workspace reference. Does not rename the actual workspace.",
    z.object({ revision, id, title }).strict(),
    (document, input) => {
      const node = document.nodes.find((candidate) => candidate.id === input.id);
      if (!node) throw new Error("Organization entry not found");
      return updateNode(document, { ...node, title: input.title });
    },
  );
  mutation(
    "move_pinned_entry",
    "Reorder an entry or move it into a folder/top level. A folder's subtree moves with it. Self/descendant nesting is rejected.",
    z.object({ revision, id, parentId, beforeId }).strict(),
    (document, input) => relocateNode(document, input),
  );
  mutation(
    "remove_pinned_entry",
    "Remove only a shared navigation reference. Removing a folder promotes its children in order. Never archives or deletes workspace files, agents or the real workspace.",
    z.object({ revision, id }).strict(),
    (document, input) => removeNode(document, input.id),
  );
  mutation(
    "set_pinned_project_link",
    "Attach a named HTTPS Notion/project link to a folder or workspace reference. Supply linkId to edit an existing link. No Notion API credentials or synchronization.",
    z
      .object({ revision, id, linkId: id.optional(), title, url: projectLinkSchema.shape.url })
      .strict(),
    (document, input) => {
      const node = document.nodes.find((candidate) => candidate.id === input.id);
      if (!node) throw new Error("Organization entry not found");
      if (input.linkId && !node.links.some((link) => link.id === input.linkId))
        throw new Error("Project link not found");
      const link = { id: input.linkId ?? newId(), title: input.title, url: input.url };
      return updateNode(document, {
        ...node,
        links: input.linkId
          ? node.links.map((current) => (current.id === link.id ? link : current))
          : [...node.links, link],
      });
    },
  );
  mutation(
    "remove_pinned_project_link",
    "Remove one attached project link without changing its folder or workspace reference.",
    z.object({ revision, id, linkId: id }).strict(),
    (document, input) => {
      const node = document.nodes.find((candidate) => candidate.id === input.id);
      if (!node || !node.links.some((link) => link.id === input.linkId))
        throw new Error("Project link not found");
      return updateNode(document, {
        ...node,
        links: node.links.filter((link) => link.id !== input.linkId),
      });
    },
  );
  return server;
}
