import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { AgentReloadOperationSchema, type AgentReloadOperation } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { acquirePidLock, releasePidLock } from "../pid-lock.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  assertForeignCleanupOwnership,
  foreignCleanupOwnershipSchema,
  observeForeignCleanupOwnership,
  type ForeignCleanupOwnership,
} from "./reload-process-ownership.js";

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
  nativeSessionIds?: string[];
}

/** Raw command/environment text never leaves this parser or enters evidence/logs. */
export function parseCleanupProcessCensus(
  output: string,
  wrapperPaths: readonly string[] = [],
): CleanupProcess[] {
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
      const nativeSessionIds = [
        ...command.matchAll(/(?:--session-id|--resume)\s+([0-9a-f-]{36})(?:\s|$)/g),
      ].map((m) => m[1]!);
      const executable = command.split(/\s/, 1)[0]!;
      const provider =
        /(?:^|[/])(?:codex|claude)$/.test(executable) ||
        /[/](?:claude[/]versions[/]|(?:@anthropic-ai[/]claude-code|@openai[/]codex)[/])/.test(
          command,
        );
      const row: CleanupProcess = {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        agentId,
        worker:
          /^(?:Paseo (?:Daemon|Supervisor))(?:\s|$)/.test(command) ||
          /(?:^|[/])(?:daemon-worker|supervisor-entrypoint(?:-impower)?)\.(?:js|ts)(?:\s|$)/.test(
            command,
          ),
        providerWriter:
          provider || wrapperPaths.some((path) => command.split(/\s+/).includes(path)),
      };
      if (nativeSessionIds.length) row.nativeSessionIds = nativeSessionIds;
      return row;
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
  wrapperPaths: readonly string[] = [],
): Promise<CleanupProcess[]> {
  try {
    const { stdout, stderr } = await run();
    if (stderr.trim()) throw new Error("Process enumeration warning");
    const rows = parseCleanupProcessCensus(stdout, wrapperPaths);
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
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Local, offline settlement only. PID lock excludes daemon admission; absence of
 * every worker excludes late callbacks. All builtin roots and inspected proxy
 * processes must be gone. This operation never signals, loads, resumes, or prompts an agent.
 */
const wrapperSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  path: z.string().refine(isAbsolute).regex(/^\S+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const inspectionFields = {
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  builtinProviderLaunchesVerified: z.literal(true),
  noRenamedOrMarkerLosingWrappers: z.literal(true),
  inspectedBy: z.string().min(1),
  evidence: z.string().min(1),
};
const launchContractSchema = z.discriminatedUnion("version", [
  z.object({ ...inspectionFields, version: z.literal(1), inspectedWrappers: z.never().optional() }),
  z.object({
    ...inspectionFields,
    version: z.literal(2),
    inspectedWrappers: z.array(wrapperSchema).min(1).max(16),
  }),
  z.object({
    ...inspectionFields,
    version: z.literal(3),
    inspectedWrappers: z.array(wrapperSchema).max(16),
    foreignOwnership: foreignCleanupOwnershipSchema,
  }),
]);
type LaunchContract = z.infer<typeof launchContractSchema>;
interface WrapperFile {
  provider: "codex" | "claude";
  path: string;
  bytes: Buffer;
}

async function readInspectedWrappers(
  contract: LaunchContract,
  config: Record<string, unknown>,
): Promise<WrapperFile[]> {
  const providers = (
    config.agents as { providers?: Record<string, { command?: unknown }> } | undefined
  )?.providers;
  const files: WrapperFile[] = [];
  for (const wrapper of contract.inspectedWrappers ?? []) {
    if (files.some((entry) => entry.path === wrapper.path))
      throw new Error("Duplicate inspected wrapper");
    const command = providers?.[wrapper.provider]?.command;
    if (!Array.isArray(command) || command.length !== 1 || command[0] !== wrapper.path)
      throw new Error("Inspected wrapper is not the configured single-path provider command");
    const stat = await lstat(wrapper.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Wrapper must be a regular file");
    const bytes = await readFile(wrapper.path);
    if (sha256(bytes) !== wrapper.sha256) throw new Error("Wrapper changed since inspection");
    files.push({ provider: wrapper.provider, path: wrapper.path, bytes });
  }
  return files;
}

function verifyConfiguredLaunches(config: Record<string, unknown>, wrappers: WrapperFile[]): void {
  const providers = (
    config.agents as
      | { providers?: Record<string, { enabled?: boolean; command?: unknown }> }
      | undefined
  )?.providers;
  for (const [provider, value] of Object.entries(providers ?? {})) {
    if (value.enabled === false || value.command === undefined) continue;
    const command = value.command;
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((arg) => typeof arg !== "string")
    )
      throw new Error("Uninspected provider command; cleanup remains unknown");
    if (!["codex", "claude"].includes(provider) || basename(command[0]) !== provider) {
      if (!wrappers.some((entry) => entry.provider === provider && entry.path === command[0]))
        throw new Error("Uninspected provider command; cleanup remains unknown");
    }
  }
}

async function verifyWrapperFilesUnchanged(files: WrapperFile[]): Promise<void> {
  for (const entry of files) {
    const stat = await lstat(entry.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(await readFile(entry.path)).equals(entry.bytes)
    )
      throw new Error("Wrapper changed during verification");
  }
}

async function readLaunchContract(input: CleanupObservationInput) {
  const launchContractBytes = await readFile(input.launchContractFile, "utf8");
  const parsed = launchContractSchema.safeParse(JSON.parse(launchContractBytes));
  if (!parsed.success)
    throw new Error(
      "A source-bound builtin launch-contract inspection is required; uninspected or renamed launches are unsupported",
    );
  const launchContract = parsed.data;
  const configBytes = await readFile(join(input.home, "config.json"), "utf8");
  if (launchContract.configSha256 !== sha256(configBytes))
    throw new Error("Daemon configuration changed since launch-contract inspection");
  const config = JSON.parse(configBytes);
  const wrapperFiles = await readInspectedWrappers(launchContract, config);
  verifyConfiguredLaunches(config, wrapperFiles);
  return { launchContractBytes, launchContract, configBytes, wrapperFiles };
}

type CleanupObservationInput = Omit<CleanupRecoveryInput, "retiredWorkerPid">;
type ObserveForeign = (
  input: CleanupObservationInput,
  frozen: ForeignCleanupOwnership,
  rows: CleanupProcess[],
) => Promise<ForeignCleanupOwnership>;
const observeForeign: ObserveForeign = (input, frozen, rows) =>
  observeForeignCleanupOwnership(
    input,
    frozen.owners,
    frozen.protectedAgentRecord.path,
    frozen.protectedFiles.map((f) => f.path),
    rows,
  );

async function checkedCensus(
  input: CleanupObservationInput,
  contract: LaunchContract,
  observe: (paths: readonly string[]) => Promise<CleanupProcess[]>,
  verifyForeign: ObserveForeign,
): Promise<{ rows: CleanupProcess[]; foreignPids: number[] }> {
  const paths = (contract.inspectedWrappers ?? []).map((w) => w.path);
  const rows = await observe(paths);
  if (contract.version !== 3) return { rows, foreignPids: [] };
  const actual = await verifyForeign(input, contract.foreignOwnership, rows);
  const foreign = assertForeignCleanupOwnership(contract.foreignOwnership, actual, rows, input);
  // Signature/home/file checks can be slow. Re-enumerate the complete process set
  // afterwards, rather than combining an old forest with newer anchor facts.
  const current = await observe(paths);
  assertForeignCleanupOwnership(contract.foreignOwnership, actual, current, input);
  const confirmed = await verifyForeign(input, contract.foreignOwnership, current);
  assertForeignCleanupOwnership(contract.foreignOwnership, confirmed, current, input);
  const final = await observe(paths);
  assertForeignCleanupOwnership(contract.foreignOwnership, confirmed, final, input);
  return { rows: final, foreignPids: [...foreign] };
}

/** Pure shared predicate for the operator's preflight, drain and rollback. */
export async function readInspectedCleanupCensus(
  input: CleanupObservationInput,
): Promise<{ rows: CleanupProcess[]; foreignPids: number[] }> {
  const { launchContract } = await readLaunchContract(input);
  return checkedCensus(
    input,
    launchContract,
    (paths) => readCleanupProcessCensus(undefined, paths),
    observeForeign,
  );
}

function assertInspectedCensus(
  snapshot: { rows: CleanupProcess[]; foreignPids: number[] },
  input: CleanupRecoveryInput,
  contract: LaunchContract,
): void {
  const nativeId =
    contract.version === 3
      ? contract.foreignOwnership.protectedAgentRecord.nativeSessionId
      : undefined;
  const foreign = new Set(snapshot.foreignPids);
  // Exact target markers always win, even inside a positively foreign tree.
  for (const row of snapshot.rows) {
    if (
      contract.version === 3 &&
      (row.agentId === input.agentId || (nativeId && row.nativeSessionIds?.includes(nativeId)))
    )
      throw new Error("Protected agent/session writer remains; cleanup is unconfirmed");
  }
  assertCleanupCensus(
    snapshot.rows.filter((row) => !foreign.has(row.pid)),
    input.agentId,
  );
}

function validateRecoveryInput(input: CleanupRecoveryInput): void {
  if (
    !Number.isInteger(input.retiredWorkerPid) ||
    input.retiredWorkerPid <= 1 ||
    input.retiredWorkerPid === process.pid
  )
    throw new Error("A captured retired worker PID is required");
  if (!/^[a-f0-9]{64}$/.test(input.expectedReceiptSha256))
    throw new Error("Expected original receipt SHA256 is required");
}

async function reconcileStoppedReloadCleanupInternal(
  input: CleanupRecoveryInput,
  observe: (wrapperPaths: readonly string[]) => Promise<CleanupProcess[]> = (paths) =>
    readCleanupProcessCensus(undefined, paths),
  verifyRetired: (pid: number) => void = assertGone,
  verifyForeign: ObserveForeign = observeForeign,
): Promise<AgentReloadOperation> {
  validateRecoveryInput(input);
  await acquirePidLock(input.home, null);
  try {
    const { launchContractBytes, launchContract, configBytes, wrapperFiles } =
      await readLaunchContract(input);
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
    const first = await checkedCensus(input, launchContract, observe, verifyForeign);
    assertInspectedCensus(first, input, launchContract);
    const second = await checkedCensus(input, launchContract, observe, verifyForeign);
    assertInspectedCensus(second, input, launchContract);
    const before = first.rows;
    const after = second.rows;
    verifyRetired(input.retiredWorkerPid);
    if ((await readFile(file, "utf8")) !== originalBytes)
      throw new Error("Reload receipt changed during verification");
    if (
      (await readFile(join(input.home, "config.json"), "utf8")) !== configBytes ||
      (await readFile(input.launchContractFile, "utf8")) !== launchContractBytes
    )
      throw new Error("Launch contract changed during verification");
    await verifyWrapperFilesUnchanged(wrapperFiles);
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
      ...(launchContract.version === 3 ? { foreignPids: second.foreignPids } : {}),
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
  observe?: (wrapperPaths: readonly string[]) => Promise<CleanupProcess[]>,
  verifyRetired?: (pid: number) => void,
  verifyForeign?: ObserveForeign,
): Promise<AgentReloadOperation> {
  if (recoveryHomes.has(input.home))
    throw new Error("Cleanup reconciliation is already in progress for this home");
  recoveryHomes.add(input.home);
  try {
    return await reconcileStoppedReloadCleanupInternal(
      input,
      observe,
      verifyRetired,
      verifyForeign,
    );
  } finally {
    recoveryHomes.delete(input.home);
  }
}
