import type { HostConnection } from "@/types/host-connection";

export interface ConnectionCandidate {
  connectionId: string;
  connection: HostConnection;
}

export type ConnectionProbeState =
  | { status: "pending"; latencyMs: null }
  | { status: "unavailable"; latencyMs: null }
  | { status: "available"; latencyMs: number };

export interface SelectBestConnectionInput {
  candidates: ConnectionCandidate[];
  probeByConnectionId: Map<string, ConnectionProbeState>;
  preferredConnectionId?: string | null;
}

function getAvailableLatency(input: {
  connectionId: string;
  probeByConnectionId: Map<string, ConnectionProbeState>;
}): number | null {
  const probe = input.probeByConnectionId.get(input.connectionId);
  return probe?.status === "available" ? probe.latencyMs : null;
}

export function selectBestConnection(input: SelectBestConnectionInput): string | null {
  const { candidates, probeByConnectionId } = input;
  if (candidates.length === 0) {
    return null;
  }

  let bestConnectionId: string | null = null;
  let bestLatency: number | null = null;
  let bestPriority = Infinity;

  for (const candidate of candidates) {
    const latencyMs = getAvailableLatency({
      connectionId: candidate.connectionId,
      probeByConnectionId,
    });
    if (latencyMs === null) {
      continue;
    }
    // Discovered routes are fallbacks; they must not displace a saved connection.
    let priority = 1;
    if (candidate.connection.type === "routed") priority = 2;
    else if (candidate.connectionId === input.preferredConnectionId) priority = 0;
    if (
      priority < bestPriority ||
      (priority === bestPriority && (bestLatency === null || latencyMs < bestLatency))
    ) {
      bestConnectionId = candidate.connectionId;
      bestLatency = latencyMs;
      bestPriority = priority;
    }
  }

  return bestConnectionId;
}
