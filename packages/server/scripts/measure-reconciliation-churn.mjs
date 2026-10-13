import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { loadavg, getPriority } from "node:os";
import { join, dirname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    background: { type: "string" },
    fixture: { type: "string" },
    output: { type: "string" },
    label: { type: "string" },
    seconds: { type: "string", default: "180" },
  },
});
for (const key of ["module", "background", "fixture", "output", "label"]) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
if (getPriority() < 10) throw new Error("Run each arm under nice -n 10 or lower priority");
const fixture = JSON.parse(await readFile(values.fixture, "utf8"));
const background = JSON.parse(await readFile(values.background, "utf8"));
if (!background.complete || background.workspaces < 91)
  throw new Error("Need 91 preserved background roots");
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 120 || seconds > 600)
  throw new Error("Score window must be 120–600 seconds");
await mkdir(values.output, { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const deadline = started + 850_000;
const hardCap = setTimeout(() => process.exit(124), 890_000);
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = (row) =>
  process.stdout.write(
    JSON.stringify({ label: values.label, atMs: performance.now() - started, ...row }) + "\n",
  );
const file = (suffix) => join(values.output, `${values.label}-${suffix}`);
const cwd = join(values.output, `${values.label}-next-worktree`);
const observerDir = dirname(values.module);
const observerFiles = ["index.js", "internal/native-recursive.js", "internal/observation.js"];
const moduleHashes = {};
for (const path of observerFiles)
  moduleHashes[path] = createHash("sha256")
    .update(await readFile(join(observerDir, path)))
    .digest("hex");
const { createFileObserver } = await import(pathToFileURL(values.module));
const observer = createFileObserver();
const roots = [
  ...Array.from({ length: 91 }, (_, i) => join(background.base, `worktree-${i + 1}`)),
  cwd,
];
const failures = [],
  windows = [],
  loads = [],
  phases = [];
const batches = { count: 0, max: 0, events: 0 };
const lastEvents = new Map();
const histogram = monitorEventLoopDelay({ resolution: 10 });
const intervalHistogram = monitorEventLoopDelay({ resolution: 10 });
let scoring = false,
  scoringStart = 0,
  ticker,
  scorer;
let peakHeapBytes = 0;
let completed = false;
async function command(executable, args, directory, label) {
  const at = performance.now(),
    loadAtIssue = loadavg();
  output({ phase: `${label}-start`, load: loadAtIssue });
  const result = await exec(executable, args, {
    cwd: directory,
    timeout: Math.min(240_000, Math.max(1_000, deadline - performance.now() - 20_000)),
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  await writeFile(file(`${label}.log`), result.stdout + result.stderr);
  const row = {
    phase: label,
    elapsedMs: performance.now() - at,
    loadAtIssue,
    loadAtCompletion: loadavg(),
  };
  phases.push(row);
  output(row);
}
async function until(predicate, label, timeoutMs = 120_000) {
  const end = Math.min(deadline - 20_000, performance.now() + timeoutMs);
  while (!predicate()) {
    if (performance.now() > end) throw new Error(`${label} deadline`);
    if (failures.length) throw new Error(`Observer failed: ${failures[0]}`);
    await sleep(50);
  }
}
function sampleWindow() {
  windows.push({
    elapsedMs: performance.now() - scoringStart,
    maxMs: intervalHistogram.max / 1e6,
    p99Ms: intervalHistogram.percentile(99) / 1e6,
    load: loadavg(),
  });
  intervalHistogram.reset();
}
try {
  // Fresh, complete worktrees share only the Git object database. Dependencies
  // are physically installed in each arm; no node_modules symlink or CPU load.
  await command(
    "git",
    ["worktree", "add", "--detach", cwd, fixture.revision],
    fixture.repo,
    "create",
  );
  const subscribeAt = performance.now(),
    subscribeLoad = loadavg();
  histogram.enable();
  await Promise.all(
    roots.map((root) =>
      observer.subscribe(
        root,
        (error, events) => {
          if (error) {
            failures.push(error.message);
            return;
          }
          batches.count += 1;
          batches.max = Math.max(batches.max, events.length);
          batches.events += events.length;
          for (const event of events) lastEvents.set(event.path, event.type);
        },
        { ignore: [join(root, ".git")] },
      ),
    ),
  );
  phases.push({
    phase: "coverage",
    elapsedMs: performance.now() - subscribeAt,
    loadAtIssue: subscribeLoad,
    loadAtCompletion: loadavg(),
    metrics: observer.getDiagnostics(),
    maxMs: histogram.max / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
  });
  if (observer.getDiagnostics().nativeHandleCount !== 92)
    throw new Error("Incomplete native coverage");
  // Score identical post-registration windows; startup is reported separately.
  scoring = true;
  scoringStart = performance.now();
  histogram.reset();
  intervalHistogram.enable();
  ticker = setInterval(() => {
    const memory = process.memoryUsage();
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
    const row = {
      phase: "progress",
      elapsedMs: performance.now() - scoringStart,
      load: loadavg(),
      heapUsedBytes: memory.heapUsed,
      metrics: observer.getDiagnostics(),
      batches: { ...batches },
    };
    loads.push({ elapsedMs: row.elapsedMs, load: row.load });
    output(row);
  }, 10_000);
  scorer = setInterval(sampleWindow, 30_000);
  const pnpm = "/Users/tim/.cache/node/corepack/v1/pnpm/10.29.3/bin/pnpm.cjs";
  await command(
    process.execPath,
    [pnpm, "install", "--frozen-lockfile", "--prefer-offline"],
    cwd,
    "install",
  );
  const canary = join(cwd, "bounded-reconciliation-canary.txt");
  await writeFile(canary, "staging canary\n");
  await until(() => lastEvents.has(canary), "tracked create round trip");
  await command(
    process.execPath,
    [join(cwd, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    cwd,
    "next-build",
  );
  const eventsAfterBuild = observer.getDiagnostics().nativeEventCount;
  // Exercise the indexed delete/commit path while coverage remains registered.
  const removalAt = performance.now(),
    removalLoad = loadavg();
  await rm(join(cwd, "node_modules"), { recursive: true, force: true });
  await rm(join(cwd, ".next"), { recursive: true, force: true });
  await rm(canary);
  await until(() => lastEvents.get(canary) === "delete", "tracked delete round trip");
  phases.push({
    phase: "remove-generated",
    elapsedMs: performance.now() - removalAt,
    loadAtIssue: removalLoad,
    loadAtCompletion: loadavg(),
  });
  if (performance.now() - scoringStart > seconds * 1_000) {
    throw new Error(
      "Workload exceeded fixed scoring window; discard this arm and use a longer window",
    );
  }
  await sleep(Math.max(0, seconds * 1_000 - (performance.now() - scoringStart)));
  const windowMs = performance.now() - scoringStart;
  clearInterval(ticker);
  clearInterval(scorer);
  sampleWindow();
  histogram.disable();
  intervalHistogram.disable();
  await until(() => {
    const metrics = observer.getDiagnostics();
    return (
      metrics.pendingEventCount === 0 &&
      metrics.pendingReconciliationWorkCount === 0 &&
      metrics.reconciliationInFlightCount === 0
    );
  }, "reconciliation drain");
  const metrics = observer.getDiagnostics();
  if (metrics.nativeHandleCount !== 92 || failures.length)
    throw new Error("Coverage or observer health lost");
  const summary = {
    label: values.label,
    moduleHashes,
    startedAt,
    endedAt: new Date().toISOString(),
    armMs: performance.now() - started,
    windowMs,
    niceness: getPriority(),
    coverage: 92,
    targets: 92,
    backgroundFiles: background.addedTrackedFilesPerWorkspace * 91,
    fixtureRevision: fixture.revision,
    realInstall: true,
    realNextBuild: true,
    cpuBurners: 0,
    phases,
    windows,
    loads,
    peakHeapBytes,
    batches,
    failures,
    metrics,
    eventsAfterBuild,
    maxMs: histogram.max / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    over10sWindows: windows.filter((window) => window.maxMs > 10_000).length,
    limitation:
      "Production observer and consumer loop in isolated staging, not the live agent/provider heap or a causal attribution of saved stalls.",
  };
  await writeFile(file("summary.json"), JSON.stringify(summary, null, 2) + "\n");
  output({
    phase: "complete",
    summary: { ...summary, loads: undefined, windows: undefined, phases: undefined },
  });
  completed = true;
} catch (error) {
  await writeFile(
    file("failure.json"),
    JSON.stringify(
      {
        error: String(error),
        armMs: performance.now() - started,
        load: loadavg(),
        phases,
        windows,
        metrics: observer.getDiagnostics(),
        failures,
      },
      null,
      2,
    ) + "\n",
  );
  output({ phase: "failed", error: String(error) });
} finally {
  clearInterval(ticker);
  clearInterval(scorer);
  if (scoring) {
    histogram.disable();
    intervalHistogram.disable();
  }
  await observer.close();
  await command("git", ["worktree", "remove", "--force", cwd], fixture.repo, "cleanup");
  clearTimeout(hardCap);
  process.exit(completed ? 0 : 1);
}
