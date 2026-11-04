import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
} from "./agent-sdk-types.js";
import { redactPermissionResponse } from "./secret-answer.js";
import { startAgentRun, type AgentRunController } from "./agent-prompt.js";

export interface PermissionResponseAgentManager extends AgentRunController {
  getPendingPermissionRequest?(
    agentId: string,
    requestId: string,
  ): AgentPermissionRequest | undefined;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
}

export interface RespondToAgentPermissionParams {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
  logger: Logger;
}

export async function respondToAgentPermission(
  params: RespondToAgentPermissionParams,
): Promise<AgentPermissionResponse> {
  const { agentManager, agentId, requestId, response, logger } = params;
  logger.debug(
    { agentId, requestId },
    `Handling permission response for agent ${agentId}, request ${requestId}`,
  );

  const safeResponse = redactPermissionResponse(
    response,
    agentManager.getPendingPermissionRequest?.(agentId, requestId) ??
      agentManager.getAgent(agentId)?.pendingPermissions.get(requestId),
  );
  const result = await agentManager.respondToPermission(agentId, requestId, safeResponse);
  logger.debug({ agentId }, `Permission response forwarded to agent ${agentId}`);

  if (result?.followUpPrompt) {
    logger.debug({ agentId }, "Permission response requires follow-up turn, starting agent stream");
    await startAgentRun(agentManager, agentId, result.followUpPrompt, logger, {
      replaceRunning: true,
    });
  }
  return safeResponse;
}
