import type { AgentManager } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export interface AppendTimelineItemIfAgentKnownOptions {
  agentManager: AgentManager;
  agentId: string;
  item: AgentTimelineItem;
}

export async function appendTimelineItemIfAgentKnown(
  options: AppendTimelineItemIfAgentKnownOptions,
): Promise<boolean> {
  return (await options.agentManager.appendTimelineItem(options.agentId, options.item)) !== null;
}

export async function emitLiveTimelineItemIfAgentKnown(
  options: AppendTimelineItemIfAgentKnownOptions,
): Promise<boolean> {
  return options.agentManager.emitLiveTimelineItem(options.agentId, options.item);
}
