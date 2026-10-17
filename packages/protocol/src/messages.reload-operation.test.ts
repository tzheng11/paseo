import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("credential reload wire compatibility", () => {
  test("preserves the existing idle-only reload request and response", () => {
    const request = {
      type: "agent.reload_idle.request",
      agentId: "agent-1",
      requestId: "request-1",
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const response = {
      type: "agent.reload_idle.response",
      payload: {
        status: "agent_refreshed",
        agentId: "agent-1",
        requestId: "request-1",
        timelineSize: 4,
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("generated validation retains the durable receipt fields", () => {
    const envelope = {
      type: "session",
      message: {
        type: "agent.reload_idle.operation.response",
        payload: {
          requestId: "request-1",
          operation: {
            operationId: "operation-1",
            agentId: "agent-1",
            status: "refused",
            reasonCode: "AGENT_RELOAD_BUSY",
            reason: "Agent is busy",
            retryable: true,
          },
        },
      },
    };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  });

  test("an unknown operation is a nullable lookup result", () => {
    const response = {
      type: "agent.reload_idle.get_operation.response",
      payload: { requestId: "status-1", operation: null },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });
});

test("quota recovery optional fields survive pure request schema and generated outbound validation", () => {
  const intent = {
    credentialGeneration: "opaque-generation",
    credentialChangedAt: "2026-10-17T12:00:00.000Z",
  };
  const request = {
    type: "agent.reload_idle.request",
    agentId: "agent",
    operationId: "operation",
    requestId: "request",
    preserveHistory: true,
    ...intent,
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  const envelope = {
    type: "session",
    message: {
      type: "agent.reload_idle.operation.response",
      payload: {
        requestId: "request",
        operation: {
          agentId: "agent",
          operationId: "operation",
          status: "completed",
          ...intent,
          continuation: {
            status: "submitted",
            failedTurnId: "typed-failed-turn",
            messageId: "quota-recovery-stable",
          },
        },
      },
    },
  };
  expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
});
