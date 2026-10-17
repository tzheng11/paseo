import type { DaemonClient, FetchAgentsOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export async function fetchAllAgents(
  client: Pick<DaemonClient, "fetchAgents">,
  options: FetchAgentsOptions = {},
): Promise<AgentSnapshotPayload[]> {
  const agents = new Map<string, AgentSnapshotPayload>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const payload = await client.fetchAgents({
      ...options,
      // Creation time stays stable when an agent updates between pages.
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of payload.entries) agents.set(entry.agent.id, entry.agent);
    const pageInfo = payload.pageInfo;
    if (!pageInfo || typeof pageInfo.hasMore !== "boolean") {
      throw new Error("Invalid agent pagination metadata");
    }
    const nextCursor = pageInfo.nextCursor;
    if (!pageInfo.hasMore) {
      if (nextCursor !== null) throw new Error("Invalid agent pagination metadata");
      break;
    }
    if (typeof nextCursor !== "string" || !nextCursor.trim() || seenCursors.has(nextCursor)) {
      throw new Error("Invalid or repeated agent pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return [...agents.values()];
}

export async function resolveAgent(
  client: Pick<DaemonClient, "fetchAgent" | "fetchAgents">,
  idOrName: string,
): Promise<AgentSnapshotPayload | null> {
  const fullId = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(idOrName);
  if (fullId) {
    const result = await client.fetchAgent({ agentId: idOrName.toLowerCase() });
    // The daemon also accepts titles; an exact-ID request must never redirect to one.
    return result?.agent.id.toLowerCase() === idOrName.toLowerCase() ? result.agent : null;
  }
  const agents = await fetchAllAgents(client, {
    filter: { includeArchived: true },
  });
  const agentId = resolveAgentId(idOrName, agents);
  return agents.find((agent) => agent.id === agentId) ?? null;
}

/** Minimal agent type for ID resolution */
interface AgentLike {
  id: string;
  title?: string | null;
}

/**
 * Resolve an agent ID from a partial ID or name.
 * Supports:
 * - Full ID match
 * - Prefix match (first N characters)
 * - Title/name match (case-insensitive)
 *
 * Returns the full agent ID if found, null otherwise.
 */
export function resolveAgentId(idOrName: string, agents: AgentLike[]): string | null {
  if (!idOrName || agents.length === 0) {
    return null;
  }

  const query = idOrName.toLowerCase();

  // Try exact ID match first
  const exactMatch = agents.find((a) => a.id === idOrName);
  if (exactMatch) {
    return exactMatch.id;
  }

  // Try ID prefix match
  const prefixMatches = agents.filter((a) => a.id.toLowerCase().startsWith(query));
  if (prefixMatches.length > 0) {
    return prefixMatches.length === 1 ? prefixMatches[0]!.id : null;
  }

  // Try title/name match (case-insensitive)
  const titleMatches = agents.filter((a) => a.title?.toLowerCase() === query);
  if (titleMatches.length > 0) {
    return titleMatches.length === 1 ? titleMatches[0]!.id : null;
  }

  const partialTitleMatches = agents.filter((a) => a.title?.toLowerCase().includes(query));
  return partialTitleMatches.length === 1 ? partialTitleMatches[0]!.id : null;
}
