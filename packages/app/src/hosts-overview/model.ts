import type { HostStats } from "@getpaseo/protocol/messages";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

// The thresholds impower-fs `scripts/workspace/spawn.mjs` ranks hosts by, so the home screen
// and `/spawn` pick the same host from the same readings.
export const SWAP_LIMIT_BYTES = 4 * 1024 ** 3;
export const BUSY_IDLE_PERCENT = 15;
export const GIT_QUEUE_LIMIT = 20;

export type HostLoadWarning =
  | { kind: "swap"; bytes: number }
  | { kind: "busy"; idlePercent: number }
  | { kind: "gitQueue"; pending: number };

export type HostOverviewState =
  | { kind: "connecting" }
  | { kind: "offline" }
  | { kind: "unsupported" }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; stats: HostStats; warnings: HostLoadWarning[] };

export interface HostOverviewRow {
  serverId: string;
  label: string;
  state: HostOverviewState;
  isNext: boolean;
}

export function supportsHostStats(
  serverInfo: { features?: { hostStats?: boolean } } | null | undefined,
): boolean {
  return serverInfo?.features?.hostStats === true;
}

export function hostLoadWarnings(stats: HostStats): HostLoadWarning[] {
  const warnings: HostLoadWarning[] = [];
  const swap = stats.memory.swapUsedBytes ?? 0;
  if (swap > SWAP_LIMIT_BYTES) warnings.push({ kind: "swap", bytes: swap });
  if (stats.cpu.idlePercent < BUSY_IDLE_PERCENT) {
    warnings.push({ kind: "busy", idlePercent: stats.cpu.idlePercent });
  }
  if (stats.git.pending >= GIT_QUEUE_LIMIT) {
    warnings.push({ kind: "gitQueue", pending: stats.git.pending });
  }
  return warnings;
}

export function idleCores(stats: HostStats): number {
  return Math.round((stats.cpu.idlePercent / 100) * stats.cpu.cores * 10) / 10;
}

/** The host with the fewest warnings, then the most idle cores; null when none reports stats. */
export function pickNextHost(rows: readonly { serverId: string; state: HostOverviewState }[]) {
  let best: { serverId: string; warnings: number; idleCores: number } | null = null;
  for (const row of rows) {
    if (row.state.kind !== "ready") continue;
    const candidate = {
      serverId: row.serverId,
      warnings: row.state.warnings.length,
      idleCores: idleCores(row.state.stats),
    };
    if (
      !best ||
      candidate.warnings < best.warnings ||
      (candidate.warnings === best.warnings && candidate.idleCores > best.idleCores)
    ) {
      best = candidate;
    }
  }
  return best?.serverId ?? null;
}

export function resolveHostOverviewState(input: {
  connectionStatus: HostRuntimeConnectionStatus;
  supported: boolean;
  stats: HostStats | undefined;
  error: Error | null;
}): HostOverviewState {
  if (input.connectionStatus === "connecting" || input.connectionStatus === "idle") {
    return { kind: "connecting" };
  }
  if (input.connectionStatus !== "online") return { kind: "offline" };
  if (!input.supported) return { kind: "unsupported" };
  if (input.stats) {
    return { kind: "ready", stats: input.stats, warnings: hostLoadWarnings(input.stats) };
  }
  if (input.error) return { kind: "failed", message: input.error.message };
  return { kind: "loading" };
}

export function buildHostOverviewRows(
  hosts: readonly { serverId: string; label: string; state: HostOverviewState }[],
): HostOverviewRow[] {
  const next = pickNextHost(hosts);
  return hosts.map((host) => ({ ...host, isNext: host.serverId === next }));
}

/** Gigabytes as macOS reports them (1024³), one decimal below 10. */
export function formatGigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb < 10 ? gb.toFixed(1) : String(Math.round(gb));
}
