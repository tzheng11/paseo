import { Command } from "commander";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { runReclaimCommand, runReclaimStatusCommand, runReclaimVerifyCommand } from "./reclaim.js";
vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));
const daemonTarget = { kind: "endpoint" as const, host: "fixture.invalid:1" };
const operationId = "00000000-0000-4000-8000-000000000001";
const generation = "a".repeat(64),
  releaseEvidence = "b".repeat(64);
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const client = new DaemonClient({
    url: "ws://fixture.invalid",
    clientId: "reclaim",
    transportFactory: () => {
      throw Error("No network in unit fixture");
    },
    reconnect: { enabled: false },
  });
  vi.mocked(connectToDaemon).mockResolvedValue(client);
  const close = vi.spyOn(client, "close").mockResolvedValue();
  return { client, close };
}
it("RECLAIM default is preview only and an invalid apply never connects", async () => {
  const { client, close } = fixture();
  const preview = vi.spyOn(client, "previewWorkspaceBackingReclaim").mockResolvedValue({
    target: { kind: "orphan", path: "/fixture" },
    eligible: true,
    code: null,
    generation,
  });
  const apply = vi.spyOn(client, "reclaimWorkspaceBacking");
  await runReclaimCommand("/fixture", { daemonTarget, releaseEvidence }, new Command());
  expect(preview).toHaveBeenCalledWith({
    target: { kind: "orphan", path: "/fixture" },
    releaseEvidence,
  });
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  vi.mocked(connectToDaemon).mockClear();
  await expect(
    runReclaimCommand("/fixture", { daemonTarget, releaseEvidence, apply: true }, new Command()),
  ).rejects.toThrow();
  expect(connectToDaemon).not.toHaveBeenCalled();
});
it("RECLAIM lost reply preserves the caller UUID without retry and lookup is read-only", async () => {
  const { client, close } = fixture();
  const apply = vi
    .spyOn(client, "reclaimWorkspaceBacking")
    .mockRejectedValue({ code: "DAEMON_REQUEST_TIMEOUT" });
  await expect(
    runReclaimCommand(
      "/fixture",
      { daemonTarget, releaseEvidence, apply: true, operationId, expectedGeneration: generation },
      new Command(),
    ),
  ).rejects.toMatchObject({ code: "DAEMON_REQUEST_TIMEOUT", details: { operationId } });
  expect(apply).toHaveBeenCalledTimes(1);
  const status = vi.spyOn(client, "getWorkspaceBackingReclaimStatus").mockResolvedValue(null);
  expect(
    (await runReclaimStatusCommand(operationId, { daemonTarget }, new Command())).data,
  ).toEqual({ operationId, state: "not-found", operation: null });
  expect(status).toHaveBeenCalledWith(operationId);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(2);
});
it("RECLAIM closed hook refuses without applying or trusting a historical UUID", async () => {
  const { client, close } = fixture();
  const verify = vi
    .spyOn(client, "verifyWorkspaceBackingReclaim")
    .mockResolvedValue({ valid: false, code: "reclaim_hook_not_active" });
  const apply = vi.spyOn(client, "reclaimWorkspaceBacking");
  await expect(
    runReclaimVerifyCommand(
      operationId,
      {
        daemonTarget,
        path: "/fixture",
        expectedGeneration: generation,
        releaseEvidence,
        ownerReleased: true,
        externalReferencesClear: true,
      },
      new Command(),
    ),
  ).rejects.toMatchObject({ code: "reclaim_hook_not_active" });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
