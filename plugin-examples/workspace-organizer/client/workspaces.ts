import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { listAllWorkspaces, type Workspace } from "./discovery";

export interface WorkspaceChoice {
  serverId: string;
  hostLabel: string;
  workspace: Workspace;
}

export function useWorkspaceChoices() {
  const hosts = useHosts();
  const [generation, setGeneration] = useState(0);
  const [choices, setChoices] = useState<WorkspaceChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const lifetime = new AbortController();
    setLoading(true);
    async function discover() {
      const results = await Promise.all(
        hosts
          .filter((host) => host.status === "online")
          .map(async (host) => {
            try {
              const workspaces = await listAllWorkspaces(
                getPaseoClient(host.serverId).workspaces.list,
                lifetime.signal,
              );
              return {
                choices: workspaces.map((workspace) => ({
                  serverId: host.serverId,
                  hostLabel: host.label,
                  workspace,
                })),
                error: null,
              };
            } catch (error) {
              return {
                choices: [],
                error: `${host.label}: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }),
      );
      if (lifetime.signal.aborted) return;
      setChoices(results.flatMap((result) => result.choices));
      setErrors(results.flatMap((result) => (result.error ? [result.error] : [])));
      setLoading(false);
    }
    void discover();
    return () => lifetime.abort();
  }, [hosts, generation]);
  const refresh = useCallback(() => setGeneration((current) => current + 1), []);
  return { choices, loading, errors, refresh };
}
