import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveAgent } from "../../utils/agents.js";
import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface AgentDetachResult {
  agentId: string;
  status: "detached";
}

const detachSchema: OutputSchema<AgentDetachResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
  ],
};

export async function executeAgentDetach(
  client: Pick<DaemonClient, "fetchAgent" | "fetchAgents" | "detachAgent">,
  agentIdArg: string,
): Promise<SingleResult<AgentDetachResult>> {
  const agent = await resolveAgent(client, agentIdArg);
  if (!agent) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${agentIdArg}`,
    } satisfies CommandError;
  }
  const agentId = agent.id;
  await client.detachAgent(agentId);
  return { type: "single", data: { agentId, status: "detached" }, schema: detachSchema };
}

export async function runDetachCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentDetachResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    return await executeAgentDetach(client, agentIdArg);
  } finally {
    await client.close().catch(() => undefined);
  }
}
