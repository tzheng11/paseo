import { resolve } from "node:path";
import type { AgentManager, ManagedAgent } from "./agent/agent-manager.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { WORKING_TREE_OBSERVATION_IDLE_GRACE_MS } from "./workspace-git-observation-policy.js";

/** Agent execution owns working-tree coverage even when every client disconnects. */
export function observeActiveWorkspaceGit(deps: {
  agentManager: Pick<AgentManager, "subscribe">;
  workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace">;
}): () => void {
  const agents = new Map<string, string>();
  const targets = new Map<string, { unsubscribe: () => void; idleTimer: NodeJS.Timeout | null }>();

  function releaseIfIdle(cwd: string): void {
    const target = targets.get(cwd);
    if (!target || [...agents.values()].includes(cwd) || target.idleTimer) return;
    target.idleTimer = setTimeout(() => {
      targets.delete(cwd);
      target.unsubscribe();
    }, WORKING_TREE_OBSERVATION_IDLE_GRACE_MS);
    target.idleTimer.unref?.();
  }

  function update(agent: ManagedAgent): void {
    const previous = agents.get(agent.id);
    agents.delete(agent.id);
    if (agent.lifecycle === "running" || agent.lifecycle === "initializing") {
      const cwd = resolve(agent.cwd);
      agents.set(agent.id, cwd);
      const target = targets.get(cwd);
      if (target?.idleTimer) {
        clearTimeout(target.idleTimer);
        target.idleTimer = null;
      }
      if (!target) {
        targets.set(cwd, {
          ...deps.workspaceGitService.registerWorkspace({ cwd }, () => {}),
          idleTimer: null,
        });
      }
    }
    if (previous) releaseIfIdle(previous);
  }

  const unsubscribe = deps.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state") update(event.agent);
    },
    { replayState: true, includeInternal: true },
  );
  return () => {
    unsubscribe();
    agents.clear();
    for (const target of targets.values()) {
      if (target.idleTimer) clearTimeout(target.idleTimer);
      target.unsubscribe();
    }
    targets.clear();
  };
}
