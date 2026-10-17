import { resolveAgent } from "../../utils/agents.js";
import { Command } from "commander";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentReloadOperation } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface AgentReloadResult {
  agentId: string;
  status: "reloaded";
  timelineSize: number;
}

export const reloadSchema: OutputSchema<AgentReloadResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "TIMELINE", field: "timelineSize" },
  ],
};

export function addReloadOptions(cmd: Command): Command {
  return cmd
    .description("Reload an agent (restarts the underlying process)")
    .argument("<id>", "Agent ID, prefix, or name")
    .option("--only-if-idle", "Refuse to reload an active agent; never interrupt a turn")
    .option("--preserve-history", "Reload credentials without replaying provider history")
    .option(
      "--operation-id <uuid>",
      "Durable credential reload operation ID (requires a full agent ID)",
    )
    .option("--credential-generation <id>", "Opaque confirmed account-switch generation")
    .option("--credential-changed-at <iso>", "Confirmed same-host account-switch time");
}

export interface AgentReloadOptions extends CommandOptions {
  host?: string;
  onlyIfIdle?: boolean;
  preserveHistory?: boolean;
  operationId?: string;
  credentialGeneration?: string;
  credentialChangedAt?: string;
}

export type AgentReloadData = AgentReloadResult | AgentReloadOperation;

export type AgentReloadCommandResult =
  | SingleResult<AgentReloadResult>
  | SingleResult<AgentReloadOperation>;

export const credentialReloadSchema: OutputSchema<AgentReloadOperation> = {
  idField: "operationId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "OPERATION ID", field: "operationId" },
    { header: "STATUS", field: "status" },
    { header: "REASON", field: "reason" },
  ],
};

export type AgentReloadRequest =
  | { kind: "ordinary"; agentIdArg: string; onlyIfIdle: boolean }
  | {
      kind: "credentials";
      agentId: string;
      operationId: string;
      credentialGeneration?: string;
      credentialChangedAt?: string;
    };

export function parseAgentReloadRequest(
  agentIdArg: string,
  options: Pick<
    AgentReloadOptions,
    | "onlyIfIdle"
    | "preserveHistory"
    | "operationId"
    | "credentialGeneration"
    | "credentialChangedAt"
  >,
): AgentReloadRequest {
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent reload <id-or-name>",
    } satisfies CommandError;
  }

  if (
    options.preserveHistory ||
    options.operationId !== undefined ||
    options.credentialGeneration !== undefined ||
    options.credentialChangedAt !== undefined
  ) {
    if (!options.onlyIfIdle || !options.preserveHistory || !options.operationId) {
      throw {
        code: "INVALID_RELOAD_OPTIONS",
        message:
          "Credential reload requires --only-if-idle, --preserve-history, and --operation-id together",
      } satisfies CommandError;
    }
    if (!z.string().uuid().safeParse(agentIdArg).success) {
      throw {
        code: "INVALID_AGENT_ID",
        message: "Credential reload requires the full agent UUID",
      } satisfies CommandError;
    }
    if (!z.string().uuid().safeParse(options.operationId).success) {
      throw {
        code: "INVALID_OPERATION_ID",
        message: "--operation-id must be a UUID",
      } satisfies CommandError;
    }
    if (
      (options.credentialGeneration !== undefined || options.credentialChangedAt !== undefined) &&
      (!z.string().min(1).max(512).safeParse(options.credentialGeneration).success ||
        !z.string().datetime({ offset: true }).safeParse(options.credentialChangedAt).success)
    )
      throw {
        code: "INVALID_CREDENTIAL_CHANGE",
        message: "Credential generation and ISO changed-at timestamp are required together",
      } satisfies CommandError;
    return {
      kind: "credentials",
      agentId: agentIdArg,
      operationId: options.operationId,
      ...(options.credentialGeneration
        ? {
            credentialGeneration: options.credentialGeneration,
            credentialChangedAt: options.credentialChangedAt,
          }
        : {}),
    };
  }
  return { kind: "ordinary", agentIdArg, onlyIfIdle: options.onlyIfIdle === true };
}

export type AgentReloadClient = Pick<
  DaemonClient,
  "fetchAgent" | "fetchAgents" | "reloadAgentCredentials" | "reloadIdleAgent" | "refreshAgent"
>;

export async function executeAgentReload(
  client: AgentReloadClient,
  request: AgentReloadRequest,
): Promise<AgentReloadCommandResult> {
  if (request.kind === "credentials") {
    const operation = await client.reloadAgentCredentials({
      agentId: request.agentId,
      operationId: request.operationId,
      ...(request.credentialGeneration
        ? {
            credentialGeneration: request.credentialGeneration,
            credentialChangedAt: request.credentialChangedAt,
          }
        : {}),
    });
    return { type: "single", data: operation, schema: credentialReloadSchema };
  }

  const agent = await resolveAgent(client, request.agentIdArg);
  if (!agent) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${request.agentIdArg}`,
      details: 'Use "paseo ls" to list available agents',
    } satisfies CommandError;
  }

  const agentId = agent.id;
  const refreshed = request.onlyIfIdle
    ? await client.reloadIdleAgent({ agentId })
    : await client.refreshAgent(agentId);
  return {
    type: "single",
    data: {
      agentId: refreshed.agentId,
      status: "reloaded",
      timelineSize: refreshed.timelineSize ?? 0,
    },
    schema: reloadSchema,
  };
}

export async function runReloadCommand(
  agentIdArg: string,
  options: AgentReloadOptions,
  _command: Command,
): Promise<AgentReloadCommandResult> {
  const request = parseAgentReloadRequest(agentIdArg, options);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    return await executeAgentReload(client, request);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "RELOAD_FAILED",
      message: `Failed to reload agent: ${message}`,
    } satisfies CommandError;
  } finally {
    await client.close().catch(() => {});
  }
}
