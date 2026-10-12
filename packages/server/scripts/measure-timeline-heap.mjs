/** Staging only: bounded timeline replay, no providers, watchers, or CPU burners. */
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadavg, tmpdir } from "node:os";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    output: { type: "string" },
    seconds: { type: "string", default: "300" },
    items: { type: "string", default: "250000" },
    bytes: { type: "string", default: "8192" },
  },
});
if (!values.runtime || !values.output || !global.gc)
  throw new Error("Require --runtime, --output and --expose-gc");
const seconds = Number(values.seconds),
  totalItems = Number(values.items),
  payloadBytes = Number(values.bytes);
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 840)
  throw new Error("Arm must last 30–840 seconds");
if (!Number.isInteger(totalItems) || totalItems < 64000 || totalItems > 300000)
  throw new Error("Invalid item count");
if (!Number.isInteger(payloadBytes) || payloadBytes < 128 || payloadBytes > 16384)
  throw new Error("Invalid payload size");
const { AgentManager } = await import(
  pathToFileURL(resolve(values.runtime, "server/agent/agent-manager.js")).href
);
const { DiskAgentTimelineStore } = await import(
  pathToFileURL(resolve(values.runtime, "server/agent/disk-agent-timeline-store.js")).href
);
const cacheDirectory = await mkdtemp(resolve(tmpdir(), "paseo-gc-replay-"));
const diskStore = new DiskAgentTimelineStore({ directory: cacheDirectory });
const logger = {
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const manager = new AgentManager({
  logger,
  timelineStore: diskStore,
  pluginLifecycle: { emit() {} },
});
// Fixture holders exercise the real manager/store read paths without launching agents.
const store = manager.timelineStore,
  agentIds = [],
  counts = new Map();
const startLoad = loadavg();
const setupStart = performance.now();
const agentCount = 96,
  runningCount = 20;
for (let a = 0; a < agentCount; a++) {
  const id = `00000000-0000-4000-8000-${String(a + 1).padStart(12, "0")}`;
  agentIds.push(id);
  manager.agents.set(id, {
    id,
    provider: "codex",
    cwd: "/fixture",
    config: {},
    labels: {},
    internal: false,
    lifecycle: a < runningCount ? "running" : "idle",
    activeForegroundTurnId: a < runningCount ? `turn-${a}` : null,
  });
  store.initialize(id, { epoch: id });
  // Match the observed ~16k maximum and keep the rest smaller.
  const count =
    a < 4
      ? 16000
      : Math.floor((totalItems - 64000) / (agentCount - 4)) +
        (a - 4 < (totalItems - 64000) % (agentCount - 4) ? 1 : 0);
  counts.set(id, count);
  let batch = [];
  for (let i = 0; i < count; i++) {
    const text = Buffer.alloc(payloadBytes, 97 + (i % 26)).toString();
    let item;
    if (i % 4 === 0) {
      item = { type: "user_message", text };
    } else if (i % 4 === 1) {
      item = { type: "assistant_message", messageId: `${a}-${i}`, text };
    } else {
      item = {
        type: "tool_call",
        callId: `${a}-${i}`,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "fixture", text },
      };
    }
    batch.push({ item });
    if (batch.length === 64 || i === count - 1) {
      store.appendBatch(id, batch);
      batch = [];
    }
    if (i % 500 === 0) await new Promise((done) => setImmediate(done));
  }
}
const setupMs = performance.now() - setupStart;
// Forced GC establishes identical retained baselines; measurement uses natural GC only.
global.gc();
await new Promise((done) => setImmediate(done));
const retained = process.memoryUsage();
const gc = [],
  windows = [],
  requestMs = [],
  metricMs = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries())
    gc.push({ atMs: e.startTime, durationMs: e.duration, kind: e.detail.kind });
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
await new Promise((done) => setTimeout(done, 30));
const begin = performance.now();
let nextMetadataAt = begin,
  metadataEvents = 0,
  lastBeat = begin,
  beatMaxMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  beatMaxMs = Math.max(beatMaxMs, now - lastBeat - 10);
  lastBeat = now;
}, 10);
let peakHeap = retained.heapUsed,
  operations = 0,
  responseRows = 0,
  peakSyncMs = 0;
const sample = setInterval(() => {
  const m = process.memoryUsage();
  peakHeap = Math.max(peakHeap, m.heapUsed);
  windows.push({
    elapsedMs: performance.now() - begin,
    load: loadavg(),
    heapUsed: m.heapUsed,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: Math.max(loop.max / 1e6, beatMaxMs),
  });
  loop.reset();
  beatMaxMs = 0;
}, 1000);
while (performance.now() - begin < seconds * 1000) {
  const tick = performance.now();
  // Same 30-second metrics path plus repeated 20-client tail reads.
  if (operations % 30 === 0) {
    const t = performance.now();
    const metrics = manager.getMetricsSnapshot();
    if (metrics.timelineStats.totalItems < totalItems) throw new Error("Fixture lost history");
    metricMs.push(performance.now() - t);
  }
  const metadataDue = tick >= nextMetadataAt;
  if (metadataDue) nextMetadataAt += 10000;
  for (let a = 0; a < runningCount; a++) {
    const id = agentIds[a];
    store.append(id, { type: "user_message", text: Buffer.alloc(1024, 120).toString() });
    // Metadata events at two per second overall; history is needed only at turn end.
    if (metadataDue) {
      metadataEvents++;
      manager.dispatchStream(id, {
        type: "thinking_option_changed",
        provider: "codex",
        thinkingOptionId: null,
      });
    }
    const t = performance.now();
    const fetched = manager.fetchTimeline(id, { limit: 200 });
    requestMs.push(performance.now() - t);
    responseRows += fetched.rows.length;
    if (fetched.rows.length !== 200) throw new Error("Unexpected tail page");
  }
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  operations++;
  peakSyncMs = Math.max(peakSyncMs, performance.now() - tick);
  await new Promise((done) => setTimeout(done, Math.max(0, 1000 - (performance.now() - tick))));
}
clearInterval(sample);
clearInterval(heartbeat);
loop.disable();
observer.disconnect();
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
const elapsedMs = performance.now() - begin;
const beforeFinalGc = process.memoryUsage();
global.gc();
const result = {
  runtime: resolve(values.runtime),
  workload: {
    agentCount,
    runningCount,
    totalItems,
    payloadBytes,
    backend: "disk",
    metadataEventsPerSecond: 2,
    metadataEvents,
    seconds,
    operations,
    responseRows,
  },
  startLoad,
  endLoad: loadavg(),
  setupMs,
  retained,
  beforeFinalGc,
  retainedAfter: process.memoryUsage(),
  peakHeap,
  measuredMs: elapsedMs,
  loop: {
    windowsOver10s: windows.filter((w) => w.maxMs > 10000).length,
    windowsOver10sPerHour: (windows.filter((w) => w.maxMs > 10000).length * 3600000) / elapsedMs,
    maxMs: Math.max(...windows.map((w) => w.maxMs)),
    windowP99Ms: percentile(
      windows.map((w) => w.p99Ms),
      0.99,
    ),
    peakSyncMs,
  },
  reads: {
    count: requestMs.length,
    p50Ms: percentile(requestMs, 0.5),
    p95Ms: percentile(requestMs, 0.95),
    maxMs: Math.max(...requestMs),
  },
  metrics: { count: metricMs.length, maxMs: Math.max(...metricMs) },
  gc: {
    count: gc.length,
    totalMs: gc.reduce((n, x) => n + x.durationMs, 0),
    maxMs: Math.max(0, ...gc.map((x) => x.durationMs)),
    events: gc,
  },
  windows,
};
await mkdir(dirname(resolve(values.output)), { recursive: true });
await writeFile(values.output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    output: resolve(values.output),
    ...result,
    gc: { ...result.gc, events: undefined },
    windows: undefined,
  }),
);

diskStore.close();
await rm(cacheDirectory, { recursive: true, force: true });
