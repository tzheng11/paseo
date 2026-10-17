import { describe, expect, test } from "vitest";
import type { AgentReloadOperation } from "@getpaseo/protocol/messages";
import {
  CredentialReloadUnsupportedError,
  DaemonConnectionError,
} from "@getpaseo/client/internal/daemon-client";
import { render } from "../../output/render.js";
import { executeAgentReload, parseAgentReloadRequest, type AgentReloadClient } from "./reload.js";
import { getAgentReloadStatus, reloadStatusSchema } from "./reload-status.js";

const agentId = "177fd711-eb13-465f-a638-5ef1dd7a68e0";
const operationId = "fcb30c96-b316-4d75-bf2a-d75350e061a7";
const maintenanceOptions = { onlyIfIdle: true, preserveHistory: true, operationId };

class RecordingReloadClient implements AgentReloadClient {
  readonly reloads: Array<Pick<AgentReloadOperation, "agentId" | "operationId">> = [];
  readonly lookups: string[] = [];
  operation: AgentReloadOperation | null = { agentId, operationId, status: "pending" };
  failure: Error | null = null;

  async fetchAgent(): Promise<never> {
    throw new Error("Credential reload must not fetch an agent");
  }
  async fetchAgents(): Promise<never> {
    throw new Error("Credential reload must not list agents");
  }
  async reloadIdleAgent(): Promise<never> {
    throw new Error("Credential reload must not call ordinary idle reload");
  }
  async refreshAgent(): Promise<never> {
    throw new Error("Credential reload must not call interrupting refresh");
  }
  async reloadAgentCredentials(input: Pick<AgentReloadOperation, "agentId" | "operationId">) {
    this.reloads.push(input);
    if (this.failure) throw this.failure;
    if (!this.operation) throw new Error("Expected a start operation result");
    return this.operation;
  }
  async getAgentReloadOperation(input: { operationId: string }) {
    this.lookups.push(input.operationId);
    if (this.failure) throw this.failure;
    return this.operation;
  }
}

describe("credential reload CLI", () => {
  test.each([
    { onlyIfIdle: true, preserveHistory: true },
    { preserveHistory: true, operationId },
    { onlyIfIdle: true, operationId },
  ])("requires the complete maintenance flag set: %j", (options) => {
    expect(() => parseAgentReloadRequest(agentId, options)).toThrowError(
      expect.objectContaining({ code: "INVALID_RELOAD_OPTIONS" }),
    );
  });

  test("requires full agent and operation UUIDs", () => {
    expect(() => parseAgentReloadRequest("177fd711", maintenanceOptions)).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_ID" }),
    );
    expect(() =>
      parseAgentReloadRequest(agentId, { ...maintenanceOptions, operationId: "short" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OPERATION_ID" }));
  });

  test("keeps ordinary reload name resolution available", () => {
    expect(parseAgentReloadRequest("My agent", { onlyIfIdle: true })).toEqual({
      kind: "ordinary",
      agentIdArg: "My agent",
      onlyIfIdle: true,
    });
  });

  test.each(["pending", "completed", "refused", "failed", "unknown"] as const)(
    "returns the %s operation envelope without listing agents",
    async (status) => {
      const client = new RecordingReloadClient();
      const operation = { agentId, operationId, status, reasonCode: "RESULT", retryable: true };
      client.operation = operation;
      const result = await executeAgentReload(
        client,
        parseAgentReloadRequest(agentId, maintenanceOptions),
      );
      expect(client.reloads).toEqual([{ agentId, operationId }]);
      expect(render(result, { format: "json" })).toBe(JSON.stringify(operation, null, 2));
    },
  );

  test("lost acknowledgement remains a command error without another dispatch", async () => {
    const client = new RecordingReloadClient();
    client.failure = new DaemonConnectionError("Lost acknowledgement", "DAEMON_REQUEST_TIMEOUT");
    await expect(
      executeAgentReload(client, parseAgentReloadRequest(agentId, maintenanceOptions)),
    ).rejects.toMatchObject({ code: "DAEMON_REQUEST_TIMEOUT" });
    expect(client.reloads).toEqual([{ agentId, operationId }]);
  });

  test("status lookup returns the receipt without dispatching another reload", async () => {
    const client = new RecordingReloadClient();
    client.operation = { agentId, operationId, status: "completed" };
    await expect(getAgentReloadStatus(client, operationId)).resolves.toEqual(client.operation);
    expect(client.lookups).toEqual([operationId]);
    expect(client.reloads).toEqual([]);
  });

  test.each([
    new CredentialReloadUnsupportedError(),
    new Error("Corrupt durable receipt"),
    new DaemonConnectionError("Lost status reply", "DAEMON_REQUEST_TIMEOUT"),
  ])("status errors never become NOT_FOUND: %s", async (failure) => {
    const client = new RecordingReloadClient();
    client.failure = failure;
    await expect(getAgentReloadStatus(client, operationId)).rejects.toBe(failure);
    expect(client.reloads).toEqual([]);
  });

  test("unknown status omits agent identity and does not invent a durable receipt", async () => {
    const client = new RecordingReloadClient();
    client.operation = null;
    const data = await getAgentReloadStatus(client, operationId);
    expect(data).toEqual({ operationId, status: "unknown", reasonCode: "NOT_FOUND" });
    expect(render({ type: "single", data, schema: reloadStatusSchema }, { format: "json" })).toBe(
      JSON.stringify({ operationId, status: "unknown", reasonCode: "NOT_FOUND" }, null, 2),
    );
    expect(client.reloads).toEqual([]);
  });
});

test("quota recovery CLI carries a paired opaque generation and ISO confirmation time", async () => {
  const change = {
    credentialGeneration: "switch-B",
    credentialChangedAt: "2026-10-17T12:00:00.000Z",
  };
  const client = new RecordingReloadClient();
  const request = parseAgentReloadRequest(agentId, { ...maintenanceOptions, ...change });
  expect(request).toEqual({ kind: "credentials", agentId, operationId, ...change });
  await executeAgentReload(client, request);
  expect(client.reloads).toEqual([{ agentId, operationId, ...change }]);
});

test.each([
  { credentialGeneration: "switch-B" },
  { credentialChangedAt: "2026-10-17T12:00:00.000Z" },
  { credentialGeneration: "", credentialChangedAt: "2026-10-17T12:00:00.000Z" },
  { credentialGeneration: "switch-B", credentialChangedAt: "yesterday" },
])("quota recovery CLI refuses ambiguous credential change before dispatch: %j", (change) => {
  expect(() => parseAgentReloadRequest(agentId, { ...maintenanceOptions, ...change })).toThrowError(
    expect.objectContaining({ code: "INVALID_CREDENTIAL_CHANGE" }),
  );
});
