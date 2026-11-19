import { expect, test, vi } from "vitest";
import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "../messages.js";
import type { WorkspaceLayoutService } from "../workspace-layout-service.js";
import type { SessionDelivery } from "./owned-subscriptions/index.js";
import { createStub } from "../test-utils/class-mocks.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { WorkspaceLayoutSession } from "./workspace-layout-session.js";

const request = {
  type: "workspace.layout.commit.request" as const,
  requestId: "once",
  expected: {
    authorityServerId: "hub",
    authorityId: "00000000-0000-4000-8000-000000000001",
    epoch: "00000000-0000-4000-8000-000000000002",
    revision: 1,
    phase: "active" as const,
  },
  mutations: [
    {
      kind: "put" as const,
      entry: {
        ref: { serverId: "replica", workspaceId: "one" },
        projectId: "project",
        pinnedAt: null,
        superpinnedAt: null,
        parent: null,
        siblingOrder: null,
        pinPlacement: null,
        archivedAt: null,
        revision: 0,
      },
    },
  ],
};

test.each(["stale_revision", "workspace_cycle", "authority_busy"])(
  "forwarded %s remains a correlated refusal, not a generic failure",
  async (code) => {
    const messages: SessionOutboundMessage[] = [];
    const logger = createTestLogger();
    const log = vi.spyOn(logger, "error");
    const service = createStub<WorkspaceLayoutService>({
      commit: async () => {
        throw new DaemonRpcError({
          requestId: request.requestId,
          requestType: request.type,
          code,
          error: "refused",
        });
      },
    });
    const session = new WorkspaceLayoutSession(
      service,
      createStub<SessionDelivery>({}),
      (message) => messages.push(message),
      logger,
    );
    await session.dispatch(request);
    expect(messages).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          code,
          error: expect.any(String),
        },
      },
    ]);
    expect(log).not.toHaveBeenCalled();
  },
);

test("an unrelated error code cannot masquerade as an authority refusal", async () => {
  const messages: SessionOutboundMessage[] = [];
  const logger = createTestLogger();
  const log = vi.spyOn(logger, "error");
  const service = createStub<WorkspaceLayoutService>({
    commit: async () => {
      throw Object.assign(new Error("persistence outcome unknown"), { code: "stale_revision" });
    },
  });
  const session = new WorkspaceLayoutSession(
    service,
    createStub<SessionDelivery>({}),
    (message) => messages.push(message),
    logger,
  );
  await session.dispatch(request);
  expect(messages).toEqual([
    {
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        code: "layout_failed",
        error: expect.any(String),
      },
    },
  ]);
  expect(log).toHaveBeenCalledOnce();
});
