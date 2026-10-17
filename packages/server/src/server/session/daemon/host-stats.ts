import { readFile } from "node:fs/promises";
import { cpus, loadavg, platform, totalmem, freemem } from "node:os";

import type {
  AgentSnapshotPayload,
  HostStats,
  WorkspaceDescriptorPayload,
} from "../../messages.js";
import { getGitSchedulerLoad } from "../../../utils/run-git-command.js";
import { execCommand } from "../../../utils/spawn.js";

const COMMAND_TIMEOUT_MS = 3_000;
// A reading closer than this to the previous one is mostly noise; take a fresh sample instead.
const MIN_SAMPLE_WINDOW_MS = 2_000;
// Older than this, the average since the last poll no longer describes the host now.
const MAX_SAMPLE_WINDOW_MS = 120_000;
const FRESH_SAMPLE_MS = 1_000;

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface CpuIdleReading {
  idlePercent: number;
  sampleMs: number;
}

interface CpuSnapshot {
  times: CpuTimes;
  atMs: number;
}

export function sumCpuTimes(list: ReturnType<typeof cpus>): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of list) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

/**
 * CPU idle averaged since the previous reading, shared by every client of the daemon. A host's
 * home screen polls every 15 s, so the average covers the poll interval, about what host-health
 * measures. A reading too close to or too far from the previous one samples for 1 s instead.
 */
export class CpuIdleSampler {
  private last: CpuSnapshot | null = null;

  constructor(
    private readonly deps: {
      readTimes: () => CpuTimes;
      now: () => number;
      sleep: (ms: number) => Promise<void>;
    } = {
      readTimes: () => sumCpuTimes(cpus()),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  async read(): Promise<CpuIdleReading> {
    let start = this.last;
    const age = start ? this.deps.now() - start.atMs : Number.POSITIVE_INFINITY;
    if (!start || age < MIN_SAMPLE_WINDOW_MS || age > MAX_SAMPLE_WINDOW_MS) {
      start = this.snapshot();
      await this.deps.sleep(FRESH_SAMPLE_MS);
    }
    const end = this.snapshot();
    this.last = end;
    const total = end.times.total - start.times.total;
    const idle = end.times.idle - start.times.idle;
    return {
      idlePercent: total > 0 ? clampPercent((idle / total) * 100) : 100,
      sampleMs: end.atMs - start.atMs,
    };
  }

  private snapshot(): CpuSnapshot {
    return { times: this.deps.readTimes(), atMs: this.deps.now() };
  }
}

const sharedCpuSampler = new CpuIdleSampler();

export interface MemoryReading {
  totalBytes: number;
  usedBytes: number;
  swapUsedBytes: number | null;
  pressure: string | null;
}

/** `vm_stat` output: the page size and each "Pages …" counter, keyed by its label. */
export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? Number.NaN);
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^(.+?):\s+(\d+)\.?\s*$/.exec(line.trim());
    if (match) pages[match[1]] = Number(match[2]);
  }
  return { pageSize, pages };
}

/**
 * Memory in use the way Activity Monitor reports it: app memory (anonymous minus purgeable)
 * plus wired plus compressed. Free pages alone undercount what macOS can hand out, because
 * it keeps file cache in inactive pages.
 */
export function darwinUsedBytes(vmStat: string): number | null {
  const { pageSize, pages } = parseVmStat(vmStat);
  const anonymous = pages["Anonymous pages"];
  const purgeable = pages["Pages purgeable"] ?? 0;
  const wired = pages["Pages wired down"];
  const compressed = pages["Pages occupied by compressor"] ?? 0;
  if (!Number.isFinite(pageSize) || anonymous === undefined || wired === undefined) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

/** `sysctl -n vm.swapusage`: "total = 30720.00M  used = 29481.06M  free = …". */
export function parseSwapUsage(text: string): number | null {
  const match = /used\s*=\s*([\d.]+)([KMG])/.exec(text);
  if (!match) return null;
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] as "K" | "M" | "G"];
  return Math.round(Number(match[1]) * scale);
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function darwinPressureName(level: number): string | null {
  if (level === 1) return "normal";
  if (level === 2) return "warn";
  if (level === 4) return "critical";
  return null;
}

/** `/proc/meminfo` in kB. */
export function parseMeminfo(text: string): MemoryReading | null {
  const kb: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  if (kb.MemTotal === undefined || kb.MemAvailable === undefined) return null;
  return {
    totalBytes: kb.MemTotal,
    usedBytes: kb.MemTotal - kb.MemAvailable,
    swapUsedBytes:
      kb.SwapTotal === undefined || kb.SwapFree === undefined ? null : kb.SwapTotal - kb.SwapFree,
    pressure: null,
  };
}

async function run(command: string, args: string[]): Promise<string> {
  const result = await execCommand(command, args, { timeout: COMMAND_TIMEOUT_MS });
  return result.stdout;
}

async function readDarwinMemory(): Promise<MemoryReading> {
  const [vmStat, swap, pressure] = await Promise.all([
    run("/usr/bin/vm_stat", []),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
  ]);
  const totalBytes = totalmem();
  return {
    totalBytes,
    usedBytes: darwinUsedBytes(vmStat) ?? totalBytes - freemem(),
    swapUsedBytes: parseSwapUsage(swap),
    pressure: darwinPressureName(Number(pressure.trim())),
  };
}

async function readMemory(): Promise<MemoryReading> {
  const os = platform();
  if (os === "darwin") return readDarwinMemory();
  if (os === "linux") {
    const reading = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
    if (reading) return reading;
  }
  return {
    totalBytes: totalmem(),
    usedBytes: totalmem() - freemem(),
    swapUsedBytes: null,
    pressure: null,
  };
}

/** Counts the lists the sidebar and `paseo ls` show; callers pass them already filtered. */
export function countHostWork(input: {
  agents: readonly Pick<AgentSnapshotPayload, "status">[];
  workspaces: readonly Pick<WorkspaceDescriptorPayload, "status">[];
}): Pick<HostStats, "agents" | "workspaces"> {
  return {
    agents: {
      total: input.agents.length,
      running: input.agents.filter((agent) => agent.status === "running").length,
    },
    workspaces: {
      total: input.workspaces.length,
      running: input.workspaces.filter((workspace) => workspace.status === "running").length,
    },
  };
}

export async function collectHostStats(input: {
  listAgents: () => Promise<Pick<AgentSnapshotPayload, "status">[]>;
  listWorkspaces: () => Promise<Pick<WorkspaceDescriptorPayload, "status">[]>;
  cpuSampler?: CpuIdleSampler;
}): Promise<HostStats> {
  const [agents, workspaces, cpu, memory] = await Promise.all([
    input.listAgents(),
    input.listWorkspaces(),
    (input.cpuSampler ?? sharedCpuSampler).read(),
    readMemory(),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    ...countHostWork({ agents, workspaces }),
    cpu: { cores: cpus().length, ...cpu, loadAverage: loadavg() },
    memory,
    git: getGitSchedulerLoad(),
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
