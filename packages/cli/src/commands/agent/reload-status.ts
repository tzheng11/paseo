import { Command } from "commander";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentReloadOperation } from "@getpaseo/protocol/messages";
import { credentialReloadSchema } from "./reload.js";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

type UnknownAgentReloadStatus = Pick<
  AgentReloadOperation,
  "operationId" | "reasonCode" | "reason" | "retryable"
> & { status: "unknown" };

export type AgentReloadStatus = AgentReloadOperation | UnknownAgentReloadStatus;

export type AgentReloadStatusCommandResult =
  | SingleResult<AgentReloadOperation>
  | SingleResult<UnknownAgentReloadStatus>;

export const reloadStatusSchema: OutputSchema<UnknownAgentReloadStatus> = {
  idField: "operationId",
  columns: [
    { header: "OPERATION ID", field: "operationId" },
    {
      header: "AGENT ID",
      field: () => "-",
    },
    { header: "STATUS", field: "status" },
    { header: "REASON", field: "reason" },
  ],
};

export function addReloadStatusOptions(cmd: Command): Command {
  return cmd
    .description("Read a credential reload operation without reloading an agent")
    .argument("<operation-id>", "Durable credential reload operation UUID");
}

export async function getAgentReloadStatus(
  client: Pick<DaemonClient, "getAgentReloadOperation">,
  operationId: string,
): Promise<AgentReloadStatus> {
  const operation = await client.getAgentReloadOperation({ operationId });
  return operation ?? { operationId, status: "unknown", reasonCode: "NOT_FOUND" };
}

export async function runReloadStatusCommand(
  operationId: string,
  options: CommandOptions,
  _command: Command,
): Promise<AgentReloadStatusCommandResult> {
  if (!z.string().uuid().safeParse(operationId).success) {
    throw {
      code: "INVALID_OPERATION_ID",
      message: "Operation ID must be a UUID",
    } satisfies CommandError;
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const operation = await getAgentReloadStatus(client, operationId);
    if ("agentId" in operation) {
      return { type: "single", data: operation, schema: credentialReloadSchema };
    }
    return { type: "single", data: operation, schema: reloadStatusSchema };
  } finally {
    await client.close().catch(() => {});
  }
}
