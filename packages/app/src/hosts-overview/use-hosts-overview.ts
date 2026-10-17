import { useMemo } from "react";
import type { HostStats } from "@getpaseo/protocol/messages";
import { useFetchQueries } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  buildHostOverviewRows,
  resolveHostOverviewState,
  supportsHostStats,
  type HostOverviewRow,
} from "./model";

export const HOST_STATS_REFRESH_MS = 15_000;

/**
 * Polls every online host for its load while a caller is mounted. Polling stops with the last
 * observer, so leaving the home screen stops it.
 */
export function useHostsOverview(): HostOverviewRow[] {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);

  const inputs = hosts.map((host) => {
    const connectionStatus = statuses.get(host.serverId) ?? "connecting";
    const supported = supportsHostStats(
      runtime.getClient(host.serverId)?.getLastServerInfoMessage(),
    );
    return { host, connectionStatus, supported };
  });

  const queries = useFetchQueries<HostStats>(
    inputs.map(({ host, connectionStatus, supported }) => ({
      queryKey: ["host-stats", host.serverId],
      queryFn: async () => {
        const client = runtime.getClient(host.serverId);
        if (!client) throw new Error("Host is not connected.");
        return (await client.getHostStats()).stats;
      },
      enabled: connectionStatus === "online" && supported,
      refetchInterval: HOST_STATS_REFRESH_MS,
      dataShape: "value",
      staleTimeMs: HOST_STATS_REFRESH_MS / 2,
    })),
  );

  return buildHostOverviewRows(
    inputs.map(({ host, connectionStatus, supported }, index) => ({
      serverId: host.serverId,
      label: host.label,
      state: resolveHostOverviewState({
        connectionStatus,
        supported,
        stats: queries[index]?.data,
        error: queries[index]?.error ?? null,
      }),
    })),
  );
}
