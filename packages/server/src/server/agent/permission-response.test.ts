import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentPromptInput,
  AgentPermissionResult,
  AgentRunOptions,
  AgentPermissionResponse,
  AgentPermissionRequest,
} from "./agent-sdk-types.js";
import type { AgentStreamEvent } from "../messages.js";
import { respondToAgentPermission } from "./permission-response.js";

class FakePermissionAgentManager {
  permissionResult: AgentPermissionResult | void;
  permissionRequest?: AgentPermissionRequest;

  getPendingPermissionRequest() {
    return this.permissionRequest;
  }
  hasRunInFlight = false;
  outOfBandHandled = false;
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }> = [];
  streamRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  replacementRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> =
    [];

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    this.permissionResponses.push({ agentId, requestId, response });
    return this.permissionResult;
  }

  tryRunOutOfBand(): boolean {
    return this.outOfBandHandled;
  }

  getAgent() {
    return undefined;
  }

  hasInFlightRun(): boolean {
    return this.hasRunInFlight;
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    this.streamRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.replacementRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }
}

async function* emptyAgentStream(): AsyncGenerator<AgentStreamEvent> {}

describe("respondToAgentPermission", () => {
  const logger = createTestLogger();

  test("starts a follow-up run returned by the provider permission response", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.permissionResult = { followUpPrompt: "implement the approved plan" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "allow" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "implement the approved plan",
      },
    ]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("does not start a run when the permission response has no follow-up prompt", async () => {
    const agentManager = new FakePermissionAgentManager();

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "deny", message: "not now" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "deny", message: "not now" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("replaces an in-flight run for follow-up prompts", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.hasRunInFlight = true;
    agentManager.permissionResult = { followUpPrompt: "continue after approval" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "continue after approval",
      },
    ]);
  });
});

test("withholds secret answers in provider input and the returned WebSocket resolution", async () => {
  const agentManager = new FakePermissionAgentManager();
  const secret = "sk-proj-" + "SYNTHETIC".repeat(8);
  const response = { behavior: "deny" as const, message: secret };
  const result = await respondToAgentPermission({
    agentManager,
    agentId: "agent-1",
    requestId: "permission-1",
    response,
    logger: createTestLogger(),
  });
  expect(result.behavior).toBe("deny");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).toContain("withheld");
  expect(agentManager.permissionResponses[0].response).toEqual(result);
  expect(response.message).toBe(secret);
});

test("uses authoritative pending questions before the manager projection is populated", async () => {
  const agentManager = new FakePermissionAgentManager();
  agentManager.permissionRequest = {
    id: "early-question",
    provider: "codex",
    kind: "question",
    name: "request_user_input_async",
    input: { questions: [{ header: "Question 1", question: "Your password:" }] },
  };
  const result = await respondToAgentPermission({
    agentManager,
    agentId: "agent-1",
    requestId: "early-question",
    response: { behavior: "allow", updatedInput: { answers: { "Question 1": "tiny" } } },
    logger: createTestLogger(),
  });
  expect(agentManager.permissionResponses[0].response).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("tiny");
  expect(JSON.stringify(result)).toContain("withheld");
});
