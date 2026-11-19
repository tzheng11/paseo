import { realpath, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  DIAGNOSTICS_CPU_PROFILE_MAX_DURATION_MS,
  type DiagnosticsCpuProfileFrame,
  type DiagnosticsCpuProfileSummary,
} from "@getpaseo/protocol/messages";

// One bounded, in-process main-thread CPU profile for `diagnostics.cpu_profile`.
// No inspector port, signal or startup flag: the node:inspector Session is
// created only when an authorized request arrives and is closed in `finally`.
// The raw V8 profile never leaves this module; only sanitized frames do.

export const CPU_PROFILE_MAX_DURATION_MS = DIAGNOSTICS_CPU_PROFILE_MAX_DURATION_MS;
export const CPU_PROFILE_SAMPLING_INTERVAL_US = 2000;
export const CPU_PROFILE_MAX_FRAMES = 1500;
export const CPU_PROFILE_MAX_SAMPLES = 10_000;
export const CPU_PROFILE_MAX_RESPONSE_BYTES = 192 * 1024;
// The deadline is cooperative: a blocked main thread delays the stop.
export const CPU_PROFILE_OVERRUN_TOLERANCE_MS = 250;
// After the profiler stops, packet frames are validated against the filesystem
// under one deadline for the whole phase and one process-wide cap on calls in
// flight, shared by every request. On the deadline the request fails with
// `validation_timeout`; on cancellation with `cancelled`. A call abandoned at
// either keeps its slot until it settles, so stalled I/O limits later requests
// instead of piling up. The kernel call itself is not cancelled.
export const CPU_PROFILE_VALIDATION_DEADLINE_MS = 500;
export const CPU_PROFILE_VALIDATION_MAX_IN_FLIGHT = 8;

export type CpuProfileErrorCode =
  | "invalid_duration"
  | "busy"
  | "not_main_thread"
  | "inspector_in_use"
  | "profiler_failed"
  | "validation_timeout"
  | "cancelled";

const ERROR_MESSAGES: Record<CpuProfileErrorCode, string> = {
  invalid_duration: `CPU profile duration must be a whole number of milliseconds from 1 to ${CPU_PROFILE_MAX_DURATION_MS}`,
  busy: "A CPU profile is already running in this daemon",
  not_main_thread: "CPU profiling is only available on the daemon main thread",
  inspector_in_use: "An inspector debugger is already attached to this daemon",
  profiler_failed: "The CPU profiler failed",
  validation_timeout: "CPU profile frame validation exceeded its time limit",
  cancelled: "The CPU profile was cancelled",
};

/** Typed failure whose message is fixed text: raw inspector errors never pass through. */
export class CpuProfileError extends Error {
  constructor(readonly code: CpuProfileErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CpuProfileError";
  }
}

export interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: object): Promise<unknown>;
}

export interface CpuProfilerRuntime {
  pid: number;
  isMainThread: boolean;
  /** The open inspector listener URL, if a debugger endpoint is active. */
  inspectorUrl(): string | undefined;
  /** Monotonic milliseconds. */
  now(): number;
  createSession(): InspectorSessionLike;
}

export interface RawCpuProfile {
  nodes: Array<{
    id: number;
    callFrame: {
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** The filesystem calls packet validation makes. */
export interface PacketFs {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ isFile(): boolean }>;
}

const nodePacketFs: PacketFs = { realpath, stat };

class ValidationStopped extends Error {}

/** Resolves with `promise`, or rejects with ValidationStopped once `signal` aborts. */
function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ValidationStopped());
  const stopped = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new ValidationStopped()), { once: true });
  });
  return Promise.race([promise, stopped]);
}

/** Caps filesystem calls in flight; a slot is held until its call settles. */
export class FsOperationLimiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.running;
  }

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    const pending = Promise.resolve().then(operation);
    const release = () => this.release();
    pending.then(release, release);
    return untilStopped(pending, signal);
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ValidationStopped();
    if (this.running < this.max) {
      this.running += 1;
      return;
    }
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    this.waiting.push(grant);
    try {
      await untilStopped(granted, signal);
    } catch (error) {
      const index = this.waiting.indexOf(grant);
      if (index >= 0) this.waiting.splice(index, 1);
      else this.release(); // Granted as the signal aborted: hand the slot on.
      throw error;
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

const processFsLimiter = new FsOperationLimiter(CPU_PROFILE_VALIDATION_MAX_IN_FLIGHT);

export interface PacketValidationOptions {
  fs?: PacketFs;
  limiter?: FsOperationLimiter;
  deadlineMs?: number;
}

export async function createNodeCpuProfilerRuntime(): Promise<CpuProfilerRuntime> {
  const [inspector, workerThreads] = await Promise.all([
    import("node:inspector/promises"),
    import("node:worker_threads"),
  ]);
  return {
    pid: process.pid,
    isMainThread: workerThreads.isMainThread,
    inspectorUrl: () => inspector.url(),
    now: () => performance.now(),
    createSession: () => new inspector.Session(),
  };
}

interface ActiveCapture {
  owner: object;
  scope: object;
  cancelled: boolean;
  abort: AbortController;
}

export interface CpuProfileCaptureRequest {
  durationMs: number;
  /** The physical connection (socket) that owns the capture. */
  owner: object;
  /** The session that owns the capture; its cleanup cancels it. */
  scope: object;
}

export class CpuProfiler {
  private readonly packetRoot: string;
  private readonly loadRuntime: () => Promise<CpuProfilerRuntime>;
  private readonly validation: PacketValidationOptions | undefined;
  private runtime: Promise<CpuProfilerRuntime> | null = null;
  private active: ActiveCapture | null = null;

  constructor(options: {
    packetRoot: string;
    loadRuntime: () => Promise<CpuProfilerRuntime>;
    validation?: PacketValidationOptions;
  }) {
    this.packetRoot = options.packetRoot;
    this.loadRuntime = options.loadRuntime;
    this.validation = options.validation;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  async capture(request: CpuProfileCaptureRequest): Promise<DiagnosticsCpuProfileSummary> {
    const { durationMs } = request;
    if (
      !Number.isInteger(durationMs) ||
      durationMs < 1 ||
      durationMs > CPU_PROFILE_MAX_DURATION_MS
    ) {
      throw new CpuProfileError("invalid_duration");
    }
    if (this.active) throw new CpuProfileError("busy");
    const active: ActiveCapture = {
      owner: request.owner,
      scope: request.scope,
      cancelled: false,
      abort: new AbortController(),
    };
    this.active = active;
    try {
      return await this.run(durationMs, active);
    } catch (error) {
      // Only typed, fixed-text failures leave this module: an untyped error
      // could carry inspector, runtime or profile values.
      if (error instanceof CpuProfileError) throw error;
      throw new CpuProfileError("profiler_failed");
    } finally {
      this.active = null;
    }
  }

  cancelOwner(owner: object): void {
    if (this.active?.owner === owner) this.cancelActive();
  }

  cancelScope(scope: object): void {
    if (this.active?.scope === scope) this.cancelActive();
  }

  cancelAll(): void {
    if (this.active) this.cancelActive();
  }

  private cancelActive(): void {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    active.abort.abort();
  }

  private async run(
    durationMs: number,
    active: ActiveCapture,
  ): Promise<DiagnosticsCpuProfileSummary> {
    this.runtime ??= this.loadRuntime();
    let runtime: CpuProfilerRuntime;
    try {
      runtime = await this.runtime;
    } catch {
      // Let the next capture retry the load.
      this.runtime = null;
      throw new CpuProfileError("profiler_failed");
    }
    throwIfCancelled(active);
    if (!runtime.isMainThread) throw new CpuProfileError("not_main_thread");
    if (runtime.inspectorUrl()) throw new CpuProfileError("inspector_in_use");

    const session = runtime.createSession();
    let connected = false;
    let enabled = false;
    let started = false;
    let stopped = false;
    let profile: RawCpuProfile | undefined;
    let actualDurationMs = 0;
    try {
      session.connect();
      connected = true;
      await post(session, "Profiler.enable");
      enabled = true;
      throwIfCancelled(active);
      await post(session, "Profiler.setSamplingInterval", {
        interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
      });
      await post(session, "Profiler.start");
      started = true;
      const startedAt = runtime.now();
      await waitForDeadline(durationMs, active.abort.signal);
      const result = await post(session, "Profiler.stop");
      stopped = true;
      actualDurationMs = runtime.now() - startedAt;
      profile = (result as { profile?: RawCpuProfile } | undefined)?.profile;
    } finally {
      // Stop only the profile this request started. Cleanup failures cannot
      // replace the typed outcome; the session is released before any
      // filesystem work, so a stalled call never holds the inspector.
      if (started && !stopped) await post(session, "Profiler.stop").catch(() => undefined);
      if (enabled) await post(session, "Profiler.disable").catch(() => undefined);
      if (connected) session.disconnect();
    }
    throwIfCancelled(active);
    if (!profile) throw new CpuProfileError("profiler_failed");
    const summary = await sanitizeCpuProfile(profile, {
      packetRoot: this.packetRoot,
      pid: runtime.pid,
      requestedDurationMs: durationMs,
      actualDurationMs,
      validation: this.validation,
      signal: active.abort.signal,
    });
    // A cancel that lands while validation finishes still wins.
    throwIfCancelled(active);
    return summary;
  }
}

function throwIfCancelled(active: ActiveCapture): void {
  if (active.cancelled) throw new CpuProfileError("cancelled");
}

async function post(
  session: InspectorSessionLike,
  method: string,
  params?: object,
): Promise<unknown> {
  try {
    return await session.post(method, params);
  } catch {
    throw new CpuProfileError("profiler_failed");
  }
}

/** Resolves at the deadline, or early when the capture is cancelled. */
async function waitForDeadline(durationMs: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(durationMs, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

const PSEUDO_FRAME_KINDS = new Map<string, DiagnosticsCpuProfileFrame["kind"]>([
  ["(root)", "root"],
  ["(program)", "program"],
  ["(idle)", "idle"],
  ["(garbage collector)", "gc"],
]);
// Any script can name itself `node:<anything>` with a sourceURL. Only an exact
// public builtin id is emitted; every `node:internal/...` collapses to one fixed
// id with no subpath or position; anything else is unknown.
const NODE_BUILTIN_IDS: ReadonlySet<string> = new Set(
  builtinModules.map((id) => id.replace(/^node:/, "")),
);
const NODE_INTERNAL_PREFIX = "node:internal/";
const NODE_INTERNAL_ID = "node:internal";
const SAFE_PACKET_PATH = /^[A-Za-z0-9_@.+-]+(\/[A-Za-z0-9_@.+-]+)*$/;
const MAX_PACKET_PATH_LENGTH = 240;

interface FrameIdentity {
  kind: DiagnosticsCpuProfileFrame["kind"];
  file: string | null;
  /** Whether line and column may be emitted with `file`. */
  positioned: boolean;
}

const UNKNOWN_FRAME: FrameIdentity = { kind: "unknown", file: null, positioned: false };

/**
 * A script can claim any path with a vm filename or sourceURL, so a packet
 * frame needs an existing regular file under the packet root, and its identity
 * is the resolved path relative to the resolved root, never the URL's spelling
 * (a case variant or an in-root symlink resolves to the real file). Resolves
 * each distinct candidate URL once, after the profiler has stopped, within the
 * validation deadline and the shared in-flight cap.
 */
async function resolvePacketIdentities(
  urls: Iterable<string>,
  packetRoot: string,
  options: PacketValidationOptions & { signal?: AbortSignal },
): Promise<Map<string, string>> {
  const fs = options.fs ?? nodePacketFs;
  const limiter = options.limiter ?? processFsLimiter;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? CPU_PROFILE_VALIDATION_DEADLINE_MS);
  const stop = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const attempt = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      return await limiter.run(operation, stop);
    } catch (error) {
      if (error instanceof ValidationStopped) throw error;
      return null;
    }
  };
  const identities = new Map<string, string>();
  try {
    const realRoot = await attempt(() => fs.realpath(packetRoot));
    if (realRoot === null) return identities;
    await Promise.all(
      [...new Set(urls)].map(async (url) => {
        const candidate = packetRelativePath(url, packetRoot);
        if (!candidate) return;
        const real = await attempt(() => fs.realpath(candidate.absolute));
        if (real === null) return;
        const canonical = safeRelativePath(realRoot, real);
        if (canonical === null) return;
        const stats = await attempt(() => fs.stat(real));
        if (stats?.isFile()) identities.set(url, canonical);
      }),
    );
    return identities;
  } catch (error) {
    if (!(error instanceof ValidationStopped)) throw error;
    throw new CpuProfileError(options.signal?.aborted ? "cancelled" : "validation_timeout");
  }
}

function classifyFrame(
  callFrame: RawCpuProfile["nodes"][number]["callFrame"],
  packetIdentities: ReadonlyMap<string, string>,
): FrameIdentity {
  const url = callFrame.url ?? "";
  if (url === "") {
    if (callFrame.scriptId !== "0") return UNKNOWN_FRAME;
    const kind = PSEUDO_FRAME_KINDS.get(callFrame.functionName) ?? "native";
    return { kind, file: null, positioned: false };
  }
  if (url.startsWith(NODE_INTERNAL_PREFIX)) {
    return { kind: "node", file: NODE_INTERNAL_ID, positioned: false };
  }
  if (url.startsWith("node:")) {
    return NODE_BUILTIN_IDS.has(url.slice("node:".length))
      ? { kind: "node", file: url, positioned: true }
      : UNKNOWN_FRAME;
  }
  const file = packetIdentities.get(url);
  return file ? { kind: "packet", file, positioned: true } : UNKNOWN_FRAME;
}

function packetRelativePath(
  url: string,
  packetRoot: string,
): { absolute: string; relative: string } | null {
  let absolute: string;
  if (url.startsWith("file://")) {
    try {
      absolute = fileURLToPath(url);
    } catch {
      return null;
    }
  } else if (path.isAbsolute(url)) {
    absolute = url;
  } else {
    return null;
  }
  const relative = safeRelativePath(packetRoot, absolute);
  return relative === null ? null : { absolute, relative };
}

/** `absolute` relative to `root` with "/" separators, or null if outside or unsafe. */
function safeRelativePath(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const normalized = relative.split(path.sep).join("/");
  if (normalized.length > MAX_PACKET_PATH_LENGTH || !SAFE_PACKET_PATH.test(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

export interface SanitizeCpuProfileOptions {
  packetRoot: string;
  pid: number;
  requestedDurationMs: number;
  actualDurationMs: number;
  maxFrames?: number;
  maxSamples?: number;
  maxResponseBytes?: number;
  validation?: PacketValidationOptions;
  /** Aborts packet validation; the capture's cancellation signal. */
  signal?: AbortSignal;
}

type RawNode = RawCpuProfile["nodes"][number];

interface SampleTotals {
  counted: number;
  selfSamples: Map<number, number>;
  selfMicros: Map<number, number>;
}

/** Attribute each sample's interval (until the next sample, or the profile end) to its node. */
function countSamples(profile: RawCpuProfile, maxSamples: number): SampleTotals {
  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];
  const counted = Math.min(samples.length, maxSamples);
  const selfSamples = new Map<number, number>();
  const selfMicros = new Map<number, number>();
  let sampleTime = profile.startTime;
  for (let index = 0; index < counted; index += 1) {
    sampleTime += timeDeltas[index] ?? 0;
    const id = samples[index];
    const next =
      index + 1 < samples.length ? sampleTime + (timeDeltas[index + 1] ?? 0) : profile.endTime;
    selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + Math.max(0, next - sampleTime));
  }
  return { counted, selfSamples, selfMicros };
}

/** Depth-first order from the roots, so parents precede children. */
function depthFirstOrder(
  nodes: RawNode[],
  byId: Map<number, RawNode>,
  parentOf: Map<number, number>,
): Array<{ id: number; depth: number }> {
  const order: Array<{ id: number; depth: number }> = [];
  const stack = nodes
    .filter((node) => !parentOf.has(node.id))
    .toReversed()
    .map((node) => ({ id: node.id, depth: 0 }));
  const visited = new Set<number>();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    order.push(entry);
    const children = byId.get(entry.id)?.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ id: children[index], depth: entry.depth + 1 });
    }
  }
  return order;
}

function subtreeTotals(
  order: Array<{ id: number }>,
  parentOf: Map<number, number>,
  selfSamples: Map<number, number>,
): Map<number, number> {
  const totals = new Map<number, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const { id } = order[index];
    const total = (totals.get(id) ?? 0) + (selfSamples.get(id) ?? 0);
    totals.set(id, total);
    const parent = parentOf.get(id);
    if (parent !== undefined) totals.set(parent, (totals.get(parent) ?? 0) + total);
  }
  return totals;
}

function toFrame(
  node: RawNode,
  index: number,
  parent: number | null,
  classify: (callFrame: RawNode["callFrame"]) => FrameIdentity,
  samples: SampleTotals,
  totals: Map<number, number>,
): DiagnosticsCpuProfileFrame {
  const identity = classify(node.callFrame);
  const { positioned } = identity;
  return {
    id: index,
    parent,
    kind: identity.kind,
    file: identity.file,
    line: positioned ? node.callFrame.lineNumber + 1 : null,
    column: positioned ? node.callFrame.columnNumber + 1 : null,
    selfSamples: samples.selfSamples.get(node.id) ?? 0,
    totalSamples: totals.get(node.id) ?? 0,
    selfMicros: Math.round(samples.selfMicros.get(node.id) ?? 0),
  };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Reduce a raw V8 profile in memory to bounded positions, kinds, counts and time deltas. */
export async function sanitizeCpuProfile(
  profile: RawCpuProfile,
  options: SanitizeCpuProfileOptions,
): Promise<DiagnosticsCpuProfileSummary> {
  const maxFrames = options.maxFrames ?? CPU_PROFILE_MAX_FRAMES;
  const maxResponseBytes = options.maxResponseBytes ?? CPU_PROFILE_MAX_RESPONSE_BYTES;
  const nodes = profile.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = new Map<number, number>();
  for (const node of nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);

  const samples = countSamples(profile, options.maxSamples ?? CPU_PROFILE_MAX_SAMPLES);
  const order = depthFirstOrder(nodes, byId, parentOf);
  const totals = subtreeTotals(order, parentOf, samples.selfSamples);

  // A parent's total is at least its child's and its depth is lower, so any
  // prefix of this ranking keeps every kept frame's ancestors.
  const orderIndex = new Map(order.map((entry, index) => [entry.id, index]));
  const ranked = order
    .filter((entry) => entry.depth === 0 || (totals.get(entry.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) ||
        a.depth - b.depth ||
        orderIndex.get(a.id)! - orderIndex.get(b.id)!,
    );
  const overrunMs = Math.max(0, options.actualDurationMs - options.requestedDurationMs);
  // Every frame any build below can keep is within the first `limit` ranked.
  const limit = Math.min(ranked.length, maxFrames);
  const packetIdentities = await resolvePacketIdentities(
    ranked.slice(0, limit).map((entry) => byId.get(entry.id)!.callFrame.url ?? ""),
    options.packetRoot,
    { ...options.validation, signal: options.signal },
  );
  const classify = (callFrame: RawNode["callFrame"]) => classifyFrame(callFrame, packetIdentities);

  const build = (keep: number, bytesTruncated: boolean): DiagnosticsCpuProfileSummary => {
    const kept = ranked
      .slice(0, keep)
      .sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);
    const emittedId = new Map(kept.map((entry, index) => [entry.id, index]));
    const frames = kept.map((entry, index) => {
      const parent = parentOf.get(entry.id);
      const emittedParent = parent === undefined ? null : (emittedId.get(parent) ?? null);
      return toFrame(byId.get(entry.id)!, index, emittedParent, classify, samples, totals);
    });
    return {
      pid: options.pid,
      samplingIntervalUs: CPU_PROFILE_SAMPLING_INTERVAL_US,
      requestedDurationMs: options.requestedDurationMs,
      actualDurationMs: roundMs(options.actualDurationMs),
      overrunMs: roundMs(overrunMs),
      overrun: overrunMs > CPU_PROFILE_OVERRUN_TOLERANCE_MS,
      profileSpanMicros: Math.max(0, profile.endTime - profile.startTime),
      sampleCount: samples.counted,
      totalNodeCount: nodes.length,
      frames,
      truncated: {
        frames: keep < ranked.length,
        samples: (profile.samples?.length ?? 0) > samples.counted,
        bytes: bytesTruncated,
      },
    };
  };

  const fits = (summary: DiagnosticsCpuProfileSummary) =>
    Buffer.byteLength(JSON.stringify(summary)) <= maxResponseBytes;
  const full = build(limit, false);
  if (fits(full)) return full;
  let low = 0;
  let high = limit - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(build(middle, true))) low = middle;
    else high = middle - 1;
  }
  return build(low, true);
}

/** The daemon package root that holds `packages/server`; frames outside it are unknown. */
export function resolvePacketRoot(moduleUrl: string = import.meta.url): string {
  const file = fileURLToPath(moduleUrl);
  const marker = `${path.sep}packages${path.sep}server${path.sep}`;
  const index = file.lastIndexOf(marker);
  return index >= 0 ? file.slice(0, index) : path.dirname(file);
}

let processCpuProfiler: CpuProfiler | null = null;

/** The one profiler for this process. Nothing is loaded until a capture starts. */
export function getProcessCpuProfiler(): CpuProfiler {
  processCpuProfiler ??= new CpuProfiler({
    packetRoot: resolvePacketRoot(),
    loadRuntime: createNodeCpuProfilerRuntime,
  });
  return processCpuProfiler;
}

/** The process profiler if a request ever created it; cancellation paths never create it. */
export function getProcessCpuProfilerIfLoaded(): CpuProfiler | null {
  return processCpuProfiler;
}

/** Cancel any running capture on server shutdown. A no-op when profiling was never used. */
export function cancelProcessCpuProfile(): void {
  processCpuProfiler?.cancelAll();
}
