import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  runArchiveCommand,
  runRetirementStatusCommand,
  runRetirementVerifyCommand,
} from "./archive.js";
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
it("passes caller operation ID on a timed-out archive without retrying", async () => {
  const { archiveWorkspace, close } = fixtureClient();
  archiveWorkspace.mockRejectedValue({ code: "DAEMON_REQUEST_TIMEOUT" });
  await expect(
    runArchiveCommand(
      "a",
      { daemonTarget: target, operationId } as Parameters<typeof runArchiveCommand>[1],
      new Command(),
    ),
  ).rejects.toMatchObject({ code: "DAEMON_REQUEST_TIMEOUT" });
  expect(archiveWorkspace).toHaveBeenCalledWith("a", { operationId });
  expect(archiveWorkspace).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("reads only the same ID after timeout, including unknown and partial outcomes", async () => {
  const { client, archiveWorkspace, close } = fixtureClient();
  const status = vi.spyOn(client, "getWorkspaceRetirementStatus").mockResolvedValue(null);
  expect(
    (await runRetirementStatusCommand(operationId, { daemonTarget: target }, new Command())).data,
  ).toMatchObject({ operationId, state: "not-found", operation: null });
  expect(status).toHaveBeenCalledWith(operationId);
  expect(archiveWorkspace).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it("verification refuses a closed hook without an archive or retry", async () => {
  const { client, archiveWorkspace, close } = fixtureClient();
  const verify = vi
    .spyOn(client, "verifyWorkspaceRetirementBinding")
    .mockResolvedValue({ valid: false, code: "retirement_hook_not_active" });
  const binding = {
    workspaceId: "a",
    backingGeneration: "a".repeat(64),
    worktreePath: "/fixture/a",
    teardownCwd: "/fixture/a",
  };
  await expect(
    runRetirementVerifyCommand(operationId, { daemonTarget: target, ...binding }, new Command()),
  ).rejects.toMatchObject({ code: "WORKSPACE_RETIREMENT_BINDING_INVALID" });
  expect(verify).toHaveBeenCalledWith({ operationId, ...binding });
  expect(archiveWorkspace).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it("REV69 capability refusal stays typed at the CLI with its caller ID", async () => {
  const { archiveWorkspace, close } = fixtureClient();
  await expect(
    runArchiveCommand("a", { daemonTarget: target, operationId }, new Command()),
  ).rejects.toMatchObject({
    code: "WORKSPACE_RETIREMENT_UNSUPPORTED",
    details: { operationId, workspaceId: "a" },
  });
  expect(archiveWorkspace).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
