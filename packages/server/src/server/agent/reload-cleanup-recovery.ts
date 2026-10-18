import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentReloadOperationSchema, type AgentReloadOperation } from "@getpaseo/protocol/messages";
import { acquirePidLock, releasePidLock } from "../pid-lock.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

const execute = promisify(execFile);
export interface CleanupRecoveryInput {
  home: string;
  agentId: string;
  operationId: string;
  expectedReceiptSha256: string;
  retiredWorkerPid: number;
  launchContractFile: string;
}
export interface CleanupProcess {
  pid: number;
  ppid: number;
  agentId?: string;
  worker: boolean;
  providerWriter: boolean;
}

/** Raw command/environment text never leaves this parser or enters evidence/logs. */
export function parseCleanupProcessCensus(output: string): CleanupProcess[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error("Incomplete process census");
      const command = match[3]!;
      const markers = [...command.matchAll(/(?:^|\s)PASEO_AGENT_ID=([^\s]+)/g)].map((m) => m[1]!);
      if (new Set(markers).size > 1) throw new Error("Conflicting process ownership markers");
      const agentId = markers[0];
      const executable = command.split(/\s/, 1)[0]!;
      const provider =
        /(?:^|[/])(?:codex|claude)$/.test(executable) ||
        /[/](?:claude[/]versions[/]|(?:@anthropic-ai[/]claude-code|@openai[/]codex)[/])/.test(
          command,
        );
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        agentId,
        worker:
          /^(?:Paseo (?:Daemon|Supervisor))(?:\s|$)/.test(command) ||
          /(?:^|[/])(?:daemon-worker|supervisor-entrypoint(?:-impower)?)\.(?:js|ts)(?:\s|$)/.test(
            command,
          ),
        providerWriter: provider,
      };
    });
}

async function executeProcessCensus(): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "darwin")
    throw new Error("Offline cleanup census currently requires macOS");
  return execute("/bin/ps", ["-ww", "-U", String(process.getuid!()), "-o", "pid=,ppid=,command="], {
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
}
export async function readCleanupProcessCensus(
  run: () => Promise<{ stdout: string; stderr: string }> = executeProcessCensus,
): Promise<CleanupProcess[]> {
  try {
    const { stdout, stderr } = await run();
    if (stderr.trim()) throw new Error("Process enumeration warning");
    const rows = parseCleanupProcessCensus(stdout);
    if (!rows.some((p) => p.pid === process.pid)) throw new Error("Incomplete process census");
    return rows;
  } catch {
    // execFile errors may carry sensitive argv/stdout/stderr. Never propagate them.
    throw new Error("Complete process census could not be verified; no receipt changed");
  }
}

function assertGone(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("Cannot verify retired worker exit", { cause: error });
  }
  throw new Error("Retired worker PID still exists; cleanup is unconfirmed");
}
export function assertCleanupCensus(
  processes: CleanupProcess[],
  agentId: string,
  ownPid = process.pid,
): void {
  const blockers = processes.filter(
    (p) => p.pid !== ownPid && (p.worker || p.agentId === agentId || p.providerWriter),
  );
  if (blockers.length)
    throw new Error(
      `Cleanup census is not quiescent (PIDs ${blockers.map((p) => p.pid).join(", ")}); no receipt changed`,
    );
}
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Local, offline settlement only. PID lock excludes daemon admission; absence of
 * every worker excludes late callbacks. All builtin native provider roots
 * must be gone. This operation never signals, loads, resumes, or prompts an agent.
 */
async function readLaunchContract(input: CleanupRecoveryInput) {
  const launchContractBytes = await readFile(input.launchContractFile, "utf8");
  const launchContract = JSON.parse(launchContractBytes);
  if (
    launchContract.version !== 1 ||
    launchContract.builtinProviderLaunchesVerified !== true ||
    launchContract.noRenamedOrMarkerLosingWrappers !== true ||
    typeof launchContract.inspectedBy !== "string" ||
    !launchContract.inspectedBy ||
    typeof launchContract.evidence !== "string" ||
    !launchContract.evidence
  )
    throw new Error(
      "A source-bound builtin launch-contract inspection is required; custom wrappers are unsupported",
    );
  const configBytes = await readFile(join(input.home, "config.json"), "utf8");
  if (launchContract.configSha256 !== sha256(configBytes))
    throw new Error("Daemon configuration changed since launch-contract inspection");
  return { launchContractBytes, launchContract, configBytes };
}

async function reconcileStoppedReloadCleanupInternal(
  input: CleanupRecoveryInput,
  observe: () => Promise<CleanupProcess[]> = readCleanupProcessCensus,
  verifyRetired: (pid: number) => void = assertGone,
): Promise<AgentReloadOperation> {
  if (
    !Number.isInteger(input.retiredWorkerPid) ||
    input.retiredWorkerPid <= 1 ||
    input.retiredWorkerPid === process.pid
  )
    throw new Error("A captured retired worker PID is required");
  if (!/^[a-f0-9]{64}$/.test(input.expectedReceiptSha256))
    throw new Error("Expected original receipt SHA256 is required");
  await acquirePidLock(input.home, null);
  try {
    const { launchContractBytes, launchContract, configBytes } = await readLaunchContract(input);
    const file = join(input.home, "reload-operations", `${sha256(input.operationId)}.json`);
    const originalBytes = await readFile(file, "utf8");
    const original = AgentReloadOperationSchema.parse(JSON.parse(originalBytes));
    if (original.operationId !== input.operationId || original.agentId !== input.agentId)
      throw new Error("Reload receipt identity mismatch");
    const proofFile = `${file}.cleanup-reconciliation.json`;
    if (original.status === "failed" && original.reasonCode === "RELOAD_CLEANUP_RECONCILED") {
      const proof = JSON.parse(await readFile(proofFile, "utf8"));
      if (
        proof.originalReceiptSha256 !== input.expectedReceiptSha256 ||
        proof.resultSha256 !== sha256(originalBytes)
      )
        throw new Error("Reconciliation evidence mismatch");
      return original;
    }
    if (sha256(originalBytes) !== input.expectedReceiptSha256)
      throw new Error("Reload receipt changed; no settlement performed");
    if (
      original.status !== "unknown" ||
      original.reasonCode !== "RELOAD_CLEANUP_UNCONFIRMED" ||
      original.continuation !== undefined
    )
      throw new Error(
        "Only an unknown cleanup receipt can be reconciled; continuation/startup uncertainty is retained",
      );
    verifyRetired(input.retiredWorkerPid);
    const before = await observe();
    assertCleanupCensus(before, input.agentId);
    const after = await observe();
    assertCleanupCensus(after, input.agentId);
    verifyRetired(input.retiredWorkerPid);
    if ((await readFile(file, "utf8")) !== originalBytes)
      throw new Error("Reload receipt changed during verification");
    if (
      (await readFile(join(input.home, "config.json"), "utf8")) !== configBytes ||
      (await readFile(input.launchContractFile, "utf8")) !== launchContractBytes
    )
      throw new Error("Launch contract changed during verification");
    const result: AgentReloadOperation = {
      ...original,
      status: "failed",
      retryable: true,
      reason:
        "Previous cleanup is settled; replacement was not acknowledged. A new guarded attempt is permitted.",
      reasonCode: "RELOAD_CLEANUP_RECONCILED",
    };
    const resultBytes = JSON.stringify(result, null, 2);
    // Evidence lands first; interruption cannot fabricate a terminal receipt.
    await writeJsonFileAtomic(proofFile, {
      operationId: input.operationId,
      agentId: input.agentId,
      originalReceiptSha256: input.expectedReceiptSha256,
      resultSha256: sha256(resultBytes),
      retiredWorkerPid: input.retiredWorkerPid,
      checkedAt: new Date().toISOString(),
      before,
      after,
      launchContract,
      launchContractSha256: sha256(launchContractBytes),
    });
    await writeJsonFileAtomic(file, result);
    return result;
  } finally {
    await releasePidLock(input.home, { ownerPid: process.pid });
  }
}

const recoveryHomes = new Set<string>();
export async function reconcileStoppedReloadCleanup(
  input: CleanupRecoveryInput,
  observe?: () => Promise<CleanupProcess[]>,
  verifyRetired?: (pid: number) => void,
): Promise<AgentReloadOperation> {
  if (recoveryHomes.has(input.home))
    throw new Error("Cleanup reconciliation is already in progress for this home");
  recoveryHomes.add(input.home);
  try {
    return await reconcileStoppedReloadCleanupInternal(input, observe, verifyRetired);
  } finally {
    recoveryHomes.delete(input.home);
  }
}
