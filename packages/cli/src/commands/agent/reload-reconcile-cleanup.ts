import { Command } from "commander";
import { z } from "zod";
import { reconcileStoppedReloadCleanup } from "@getpaseo/server/reload-cleanup-recovery";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type SingleResult } from "../../output/index.js";
import type { AgentReloadOperation } from "@getpaseo/protocol/messages";
import { credentialReloadSchema } from "./reload.js";

export function reloadReconcileCleanupCommand(): Command {
  return addJsonOption(
    addLocalDaemonOptions(
      new Command("reload-reconcile-cleanup")
        .description(
          "Settle cleanup uncertainty locally while the daemon and prior writers are stopped; never restart or send a prompt",
        )
        .argument("<operation-id>", "Original operation UUID")
        .requiredOption("--agent-id <uuid>", "Original full agent UUID")
        .requiredOption("--expected-receipt-sha256 <hash>", "SHA256 of the original receipt bytes")
        .requiredOption("--retired-worker-pid <pid>", "Captured prior daemon worker PID")
        .requiredOption(
          "--launch-contract <file>",
          "Source-bound builtin launch inspection and configuration hash",
        ),
    ),
  ).action(
    withOutput<AgentReloadOperation, [string]>(
      async (
        operationId: string,
        options: CommandOptions,
        _command: Command,
      ): Promise<SingleResult<AgentReloadOperation>> => {
        const parsed = z
          .object({
            agentId: z.string().uuid(),
            expectedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
            retiredWorkerPid: z.coerce.number().int().min(2),
            launchContract: z.string().min(1),
          })
          .parse(options);
        z.string().uuid().parse(operationId);

        if (options.daemonTarget.kind !== "instance")
          throw new Error("Cleanup reconciliation is local-only");
        const operation = await reconcileStoppedReloadCleanup({
          home: options.daemonTarget.home,
          operationId,
          agentId: parsed.agentId,
          expectedReceiptSha256: parsed.expectedReceiptSha256,
          retiredWorkerPid: parsed.retiredWorkerPid,
          launchContractFile: parsed.launchContract,
        });
        return { type: "single", data: operation, schema: credentialReloadSchema };
      },
    ),
  );
}
