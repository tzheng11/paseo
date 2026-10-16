import { isWeb } from "@/constants/platform";
import {
  hostHasConnection,
  normalizeStoredHostProfile,
  StoredHostRegistrySchema,
  upsertHostConnectionInProfiles,
  type HostProfile,
} from "@/types/host-connection";

interface ReadInitialHostsInput {
  isWebRuntime?: boolean;
  value?: unknown;
}

/** Deployment connection metadata never supplies saved credentials. */
export function readInitialHosts(input: ReadInitialHostsInput = {}): HostProfile[] {
  if (!(input.isWebRuntime ?? isWeb)) return [];

  const value = "value" in input ? input.value : Reflect.get(globalThis, "__PASEO_INITIAL_HOSTS__");
  const parsed = StoredHostRegistrySchema.safeParse(value);
  if (!parsed.success) return [];

  const hosts = new Map<string, HostProfile>();
  for (const entry of parsed.data) {
    const connections = entry.connections.map((connection) => {
      if (connection.type !== "directTcp") return connection;
      return { ...connection, password: undefined };
    });
    const host = normalizeStoredHostProfile({ ...entry, password: undefined, connections });
    if (!host) return [];

    let existing = hosts.get(host.serverId);
    if (!existing) {
      hosts.set(host.serverId, host);
      continue;
    }
    for (const connection of host.connections) {
      [existing] = upsertHostConnectionInProfiles({
        profiles: [existing],
        serverId: host.serverId,
        label: existing.label,
        connection,
        now: host.updatedAt,
      });
    }
    hosts.set(host.serverId, existing);
  }
  return [...hosts.values()];
}

/** Managed routes are consistent across browsers; saved presentation and auth stay local. */
export function mergeInitialHosts(saved: HostProfile[], initial: HostProfile[]): HostProfile[] {
  if (initial.length === 0) return saved;

  const managed = new Map(initial.map((host) => [host.serverId, host]));
  const savedById = new Map<string, HostProfile>();
  for (const host of saved) {
    if (!savedById.has(host.serverId)) savedById.set(host.serverId, host);
  }
  const merged: HostProfile[] = [];

  for (const canonical of managed.values()) {
    const host = savedById.get(canonical.serverId);
    if (!host) {
      const newHost = { ...canonical };
      delete newHost.password;
      merged.push(newHost);
      continue;
    }

    const savedPreferenceIsCanonical = canonical.connections.some(
      (connection) => connection.id === host.preferredConnectionId,
    );
    const preferredConnectionId = savedPreferenceIsCanonical
      ? host.preferredConnectionId
      : canonical.preferredConnectionId;
    const sameConnections =
      host.connections.length === canonical.connections.length &&
      canonical.connections.every((connection, index) => {
        const savedConnection = host.connections[index];
        return hostHasConnection({ ...host, connections: [savedConnection] }, connection);
      });
    if (sameConnections && preferredConnectionId === host.preferredConnectionId) {
      merged.push(host);
      continue;
    }

    merged.push({
      ...host,
      connections: canonical.connections,
      preferredConnectionId,
      updatedAt: new Date().toISOString(),
    });
  }

  for (const host of saved) {
    if (!managed.has(host.serverId)) merged.push(host);
  }
  const unchanged =
    merged.length === saved.length && merged.every((host, index) => host === saved[index]);
  return unchanged ? saved : merged;
}
