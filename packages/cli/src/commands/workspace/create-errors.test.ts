import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, expect, it, vi } from "vitest";
import { runCreateCommand } from "./create.js";
import { connectToDaemon } from "../../utils/client.js";
vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: () => "fixture",
}));
vi.mock("../../utils/caller-agent.js", () => ({ resolveCallerAgentId: async () => null }));
beforeEach(() => vi.restoreAllMocks());
it.each(["permission_denied", "internal_arbitrary_code", "retirement_conflict"])(
  "REVISION1 failed create preserves the public error boundary for %s",
  async (errorCode) => {
    const client = new DaemonClient({
      url: "ws://fixture.invalid",
      clientId: "create-errors",
      reconnect: { enabled: false },
    });
    vi.mocked(connectToDaemon).mockResolvedValue(client);
    vi.spyOn(client, "createWorkspace").mockResolvedValue({
      requestId: "fixture",
      workspace: null,
      error: "Fixture refused",
      errorCode,
    });
    const close = vi.spyOn(client, "close").mockResolvedValue();
    await expect(
      runCreateCommand({ isolation: "local", path: "/owned-fixture" }, new Command()),
    ).rejects.toMatchObject({
      code: errorCode === "retirement_conflict" ? "retirement_conflict" : "WORKSPACE_CREATE_FAILED",
      message: "Fixture refused",
    });
    expect(close).toHaveBeenCalledTimes(1);
  },
);
