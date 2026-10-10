import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const name = z.string().trim().min(1, "Enter a name").max(160);
const identifier = z.string().min(1).max(200);
export const projectLinkSchema = z.object({
  id: identifier,
  title: name,
  url: z
    .string()
    .trim()
    .url()
    .refine((url) => url.toLowerCase().startsWith("https://"), {
      message: "Use an absolute HTTPS URL",
    }),
});
const base = {
  id: identifier,
  parentId: identifier.nullable(),
  title: name,
  links: z.array(projectLinkSchema).max(30).default([]),
};
export const organizationNodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("folder") }),
  z.object({
    ...base,
    kind: z.literal("workspace"),
    serverId: identifier,
    workspaceId: identifier,
  }),
]);
export type OrganizationNode = z.output<typeof organizationNodeSchema>;
export type ProjectLink = z.output<typeof projectLinkSchema>;

export const organizationSchema = z
  .object({
    nodes: z.array(organizationNodeSchema).max(1000).default([]),
  })
  .superRefine(({ nodes }, context) => {
    const byId = new Map<string, OrganizationNode>();
    const workspaces = new Set<string>();
    for (const [index, node] of nodes.entries()) {
      const problem = (message: string) =>
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message,
        });
      if (byId.has(node.id)) problem("Organization entries must have unique IDs");
      byId.set(node.id, node);
      if (new Set(node.links.map((link) => link.id)).size !== node.links.length)
        problem("Links within an entry must have unique IDs");
      if (node.kind === "workspace") {
        const key = workspaceIdentity(node.serverId, node.workspaceId);
        if (workspaces.has(key)) problem("This workspace is already in the organization");
        workspaces.add(key);
      }
    }
    for (const [index, node] of nodes.entries()) {
      const visited = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId !== null) {
        const parent = byId.get(parentId);
        let message: string | null = null;
        if (!parent) message = "The parent entry does not exist";
        else if (visited.has(parentId))
          message = "An entry cannot be nested inside itself or a descendant";
        else if (visited.size >= 20) message = "Organization nesting supports up to 20 levels";
        if (message) {
          context.addIssue({ code: "custom", path: ["nodes", index, "parentId"], message });
          break;
        }
        visited.add(parentId);
        parentId = parent!.parentId;
      }
    }
  });

export type Organization = z.output<typeof organizationSchema>;
export const organization = defineSettings({
  id: "organization",
  scope: "host",
  version: 1,
  schema: organizationSchema,
});

// JSON tuple encoding keeps identities distinct even if either component contains a separator.
export function workspaceIdentity(serverId: string, workspaceId: string): string {
  return JSON.stringify([serverId, workspaceId]);
}

export function descendants(nodes: readonly OrganizationNode[], id: string): Set<string> {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId !== null && result.has(node.parentId) && !result.has(node.id)) {
        result.add(node.id);
        changed = true;
      }
    }
  }
  return result;
}

export function updateNode(document: Organization, node: OrganizationNode): Organization {
  if (!document.nodes.some((current) => current.id === node.id))
    throw new Error("This organization entry no longer exists. Reload the organization.");
  return organizationSchema.parse({
    nodes: document.nodes.map((current) => (current.id === node.id ? node : current)),
  });
}

export function moveNode(document: Organization, id: string, direction: -1 | 1): Organization {
  const index = document.nodes.findIndex((node) => node.id === id);
  if (index === -1) throw new Error("Organization entry not found");
  const node = document.nodes[index];
  const siblings = document.nodes.filter((candidate) => candidate.parentId === node.parentId);
  const neighbor = siblings[siblings.findIndex((candidate) => candidate.id === id) + direction];
  if (!neighbor) return document;
  const otherIndex = document.nodes.findIndex((candidate) => candidate.id === neighbor.id);
  const nodes = [...document.nodes];
  [nodes[index], nodes[otherIndex]] = [nodes[otherIndex], nodes[index]];
  return organizationSchema.parse({ nodes });
}

// Removing a navigation reference never archives a workspace. Children take its place in the tree.
export function removeNode(document: Organization, id: string): Organization {
  const removed = document.nodes.find((node) => node.id === id);
  if (!removed) throw new Error("Organization entry not found");
  const children = document.nodes.filter((node) => node.parentId === id);
  return organizationSchema.parse({
    nodes: document.nodes.flatMap((node) => {
      if (node.id === id)
        return children.map((child) => Object.assign({}, child, { parentId: removed.parentId }));
      return node.parentId === id ? [] : [node];
    }),
  });
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
