import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, expect, it, vi } from "vitest";
import { runArchiveCommand } from "./archive.js";
import { connectToDaemon } from "../../utils/client.js";
vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  getDaemonHost: () => "fixture",
}));
const target = { kind: "endpoint" as const, host: "fixture.invalid:1" };
const operationId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => vi.resetAllMocks());
function fixtureClient() {
  const client = new DaemonClient({
    url: "ws://fixture.invalid",
    clientId: "archive-unit",
    transportFactory: () => {
      throw new Error("No transport allowed in this fixture");
    },
    reconnect: { enabled: false },
  });
  vi.mocked(connectToDaemon).mockResolvedValue(client);
  const archiveWorkspace = vi.spyOn(client, "archiveWorkspace");
  const close = vi.spyOn(client, "close").mockResolvedValue();
  return { client, archiveWorkspace, close };
}
it("reports a completed native archive separately from retained backing", async () => {
  const { archiveWorkspace, close } = fixtureClient();
  archiveWorkspace.mockResolvedValue({
    requestId: "archive",
    workspaceId: "a",
    archivedAt: "2026-11-19T19:00:00.000Z",
    removedDirectory: false,
    slotKept: true,
    retirement: { operationId, state: "complete" },
    error: null,
  });
  const result = await runArchiveCommand("a", { daemonTarget: target }, new Command());
  expect(result.data).toMatchObject({
    status: "archived",
    removedDirectory: false,
    slotKept: true,
    retirement: { operationId, state: "complete" },
  });
  expect(close).toHaveBeenCalledTimes(1);
});
it("returns the original operation and partial result without retrying", async () => {
  const { archiveWorkspace, close } = fixtureClient();
  archiveWorkspace.mockResolvedValue({
    requestId: "archive",
    workspaceId: "a",
    archivedAt: null,
    removedDirectory: false,
    retirement: { operationId, state: "partial", code: "retirement_effect_failed" },
    error: "Archive incomplete",
  });
  await expect(
    runArchiveCommand("a", { daemonTarget: target }, new Command()),
  ).rejects.toMatchObject({
    code: "WORKSPACE_RETIREMENT_PARTIAL",
    details: { retirement: { operationId, state: "partial" } },
  });
  expect(archiveWorkspace).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
