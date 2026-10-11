import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mock } from "node:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import pino from "pino";
import pLimit from "p-limit";
import { createFileObserver, type FileObserver } from "../src/server/file-observer/index.js";
import { WorkspaceGitServiceImpl } from "../src/server/workspace-git-service.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { summarizeWatchLoadEventLoop } from "./watch-load-metrics.js";

const exec = promisify(execFile);
const count = Number(process.env.PASEO_WATCH_LOAD_WORKSPACES ?? 85);
const packages = Number(process.env.PASEO_WATCH_LOAD_PACKAGES ?? 160);
const fdLimit = Number(process.env.PASEO_WATCH_LOAD_FD_LIMIT ?? 256);
const timeoutMs = Number(process.env.PASEO_WATCH_LOAD_TIMEOUT_MS ?? 300_000);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function report(value: object) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function until(predicate: () => boolean, label: string, ms = 120_000) {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
}

// Bound even a synchronous native-close wedge from outside the tested process.
// The shell changes only this child's rlimit, never launchd or a serving daemon.
async function parent() {
  const child = spawn(
    "bash",
    [
      "-c",
      'ulimit -S -n "$1"; shift; exec "$@"',
      "watch-load",
      String(fdLimit),
      process.execPath,
      ...process.execArgv,
      process.argv[1],
      "--child",
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  report({ phase: "child", pid: child.pid, fdLimit, timeoutMs });
  child.stdout.pipe(process.stdout);
  const timer = setTimeout(() => {
    report({
      phase: "watchdog",
      failed: true,
      reason: "scratch child exceeded hard deadline",
      pid: child.pid,
    });
    child.kill("SIGKILL");
  }, timeoutMs);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  clearTimeout(timer);
  process.exitCode = code ?? 1;
}

async function runChild() {
  if (process.platform !== "darwin") throw new Error("This load test requires real macOS FSEvents");
  const base = await realpath(
    process.env.PASEO_WATCH_LOAD_FIXTURE ?? (await mkdtemp(join(tmpdir(), "paseo-watch-load-"))),
  );
  const roots = Array.from({ length: count }, (_, i) => join(base, `workspace-${i}`));
  report({ phase: "fixture", base, count, packages, fdLimit, node: process.version });
  if (!process.env.PASEO_WATCH_LOAD_FIXTURE) {
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await exec("git", ["init", "--quiet", "--initial-branch=main", root]);
      await writeFile(
        join(root, ".gitignore"),
        "node_modules/\ndist/\n.next/\n.turbo/\ncoverage/\n",
      );
      for (let i = 0; i < packages; i++) {
        const pkg = join(root, "packages", `pkg-${i}`);
        await Promise.all(
          ["src", "test", "docs", "node_modules", "dist"].map((p) =>
            mkdir(join(pkg, p), { recursive: true }),
          ),
        );
        await writeFile(join(pkg, "src", "index.ts"), "export const x = 1;\n");
      }
      await exec("git", ["add", "."], { cwd: root });
      await exec(
        "git",
        [
          "-c",
          "user.name=Watcher load test",
          "-c",
          "user.email=watcher@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: root },
      );
    }
  }
  let phase = "native-pressure";
  let maxStallMs = 0;
  const windowStarted = performance.now();
  const longStalls: number[] = [];
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let previousTick = windowStarted;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    const stallMs = now - previousTick - 20;
    maxStallMs = Math.max(maxStallMs, stallMs);
    if (stallMs > 10_000) longStalls.push(stallMs);
    previousTick = now;
  }, 20);
  const eventLoopEvidence = () =>
    summarizeWatchLoadEventLoop(
      performance.now() - windowStarted,
      longStalls,
      histogram.count ? histogram.percentile(99) / 1_000_000 : null,
    );
  const progress = setInterval(() => report({ phase, heartbeat: true, maxStallMs }), 1_000);
  try {
    // A preserved compiled bfe0010 entry lets this exact fixture run red without
    // changing the writer branch. Do not point it at a serving runtime.
    const entry = process.env.PASEO_WATCH_LOAD_OBSERVER_ENTRY;
    const createObserver: typeof createFileObserver = entry
      ? (await import(entry)).createFileObserver
      : createFileObserver;
    const observer: FileObserver = createObserver();
    const errors: string[] = [];
    const edits = new Set<string>();
    const subscriptions = await Promise.allSettled(
      roots.map(async (root) => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("subscription deadline")),
          10_000,
        );
        const ignore = [
          join(root, ".git"),
          join(root, ".next"),
          join(root, "node_modules"),
          ...Array.from({ length: packages }, (_, i) =>
            ["dist", "node_modules"].map((p) => join(root, "packages", `pkg-${i}`, p)),
          ).flat(),
        ];
        try {
          return await observer.subscribe(
            root,
            (error, events) => {
              if (error) errors.push(error.message);
              for (const event of events) edits.add(event.path);
            },
            { ignore, signal: controller.signal },
          );
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    const registered = subscriptions.filter((s) => s.status === "fulfilled").length;
    report({
      phase: "native-admitted",
      registered,
      errors,
      failures: subscriptions.filter((s) => s.status === "rejected").map((s) => String(s.reason)),
      diagnostics: observer.getDiagnostics(),
    });
    const paths = roots.map((root) => join(root, "packages", "pkg-0", "src", "index.ts"));
    await Promise.all(paths.map((path) => writeFile(path, "export const x = 2;\n")));
    await until(
      () => paths.every((path) => edits.has(path)),
      "native coverage edit round trips",
      15_000,
    );
    report({
      phase,
      registered,
      roundTrips: paths.filter((path) => edits.has(path)).length,
      errors,
      failures: subscriptions.filter((s) => s.status === "rejected").map((s) => String(s.reason)),
      diagnostics: observer.getDiagnostics(),
    });
    if (registered !== count || errors.length) throw new Error("native coverage incomplete");
    phase = "cancellation";
    const cancelling = createObserver();
    const cancelled = await Promise.allSettled(
      roots.map((root) => {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error("load cancellation")), 5);
        return cancelling
          .subscribe(root, () => {}, {
            ignore: [join(root, "node_modules"), join(root, ".git"), join(root, ".next")],
            signal: controller.signal,
          })
          .finally(() => clearTimeout(deadline));
      }),
    );
    await cancelling.close();
    report({
      phase,
      cancelled: cancelled.filter((result) => result.status === "rejected").length,
      diagnostics: cancelling.getDiagnostics(),
    });
    if (cancelled.some((result) => result.status !== "rejected"))
      throw new Error("cancellation did not exercise pending startup");
    phase = "ignore-update";
    await Promise.all(
      subscriptions.map((s, i) =>
        s.status === "fulfilled"
          ? s.value.updateIgnore([join(roots[i], ".git"), join(roots[i], "packages")])
          : undefined,
      ),
    );
    phase = "teardown";
    const closeStart = performance.now();
    await observer.close();
    report({
      phase,
      closeMs: performance.now() - closeStart,
      diagnostics: observer.getDiagnostics(),
    });
    if (entry) {
      await sleep(50);
      report({
        phase: "native-verdict",
        functionalPassed: true,
        maxStallMs,
        eventLoop: eventLoopEvidence(),
      });
      return; // The preserved observer reproduction never starts a daemon.
    }

    const clean = pLimit(2);
    await Promise.all(
      roots.map((root) =>
        clean(async () => {
          await exec("git", ["add", "."], { cwd: root });
          await exec(
            "git",
            [
              "-c",
              "user.name=Watcher load test",
              "-c",
              "user.email=watcher@example.invalid",
              "commit",
              "--quiet",
              "--allow-empty",
              "--no-gpg-sign",
              "-m",
              "clean canary baseline",
            ],
            { cwd: root },
          );
        }),
      ),
    );
    phase = "daemon-cold-refresh";
    // Seed only scratch registry records. Production bootstrap and protocol
    // handlers stay intact; the test spy exposes aggregate admission metrics.
    const homeRoot = join(base, "daemon-home");
    const registry = join(homeRoot, ".paseo", "projects");
    await mkdir(registry, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(
      join(registry, "projects.json"),
      JSON.stringify(
        roots.map((root, i) => ({
          projectId: `prj_load${i}`,
          rootPath: root,
          kind: "git",
          displayName: `Load ${i}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        })),
      ),
    );
    await writeFile(
      join(registry, "workspaces.json"),
      JSON.stringify(
        roots.map((root, i) => ({
          workspaceId: `wks_load${i}`,
          projectId: `prj_load${i}`,
          cwd: root,
          kind: "local_checkout",
          displayName: `Load ${i}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        })),
      ),
    );
    let service: WorkspaceGitServiceImpl | undefined;
    const original = WorkspaceGitServiceImpl.prototype.registerWorkspace;
    const capture = mock.method(
      WorkspaceGitServiceImpl.prototype,
      "registerWorkspace",
      function (this: WorkspaceGitServiceImpl, ...args: Parameters<typeof original>) {
        // Test-only capture; bootstrap and protocol handlers remain unmodified.
        // eslint-disable-next-line typescript-eslint/no-this-alias
        service = this;
        return original.apply(this, args);
      },
    );
    const logPath = join(base, "staging-daemon.log");
    const log = pino.destination(logPath);
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      cleanup: false,
      mcpEnabled: false,
      relayEnabled: false,
      logger: pino({ level: "info" }, log),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents();
      const events = client.observeEvents(["checkout_status_update"]);
      await events.ready;
      await until(() => Boolean(service), "cold workspace registrations");
      const coldBefore = service!.getMetrics();
      const reads = await Promise.all(
        roots.slice(-4).map(async (root) => {
          const uncached = !service!.peekSnapshot(root);
          const start = performance.now();
          const result = await client.getCheckoutStatus(root);
          if (!result.isGit || result.error) throw new Error(`checkout_status failed: ${root}`);
          return { uncached, latencyMs: performance.now() - start };
        }),
      );
      report({ phase, coldBefore, reads, port: daemon.port, home: daemon.paseoHome, logPath });
      if (
        !coldBefore.workspaceInitialRefreshPendingCount ||
        !reads.every((read) => read.uncached && read.latencyMs < 10_000)
      )
        throw new Error("cold checkout_status bar failed");
      await until(() => {
        const m = service!.getMetrics();
        return (
          m.workingTreeWatchTargetCount === count &&
          m.workspaceObservationSetupInFlightCount === 0 &&
          m.workingTreeWatchSetupInFlightCount === 0 &&
          m.workspaceInitialRefreshPendingCount === 0 &&
          m.fileObserver.reconciliationInFlightCount === 0
        );
      }, "all workspace watchers registered");
      phase = "daemon-coverage";
      const covered = new Set<string>();
      const stop = client.on("checkout_status_update", (event) => {
        if (event.payload.isGit && event.payload.isDirty) covered.add(event.payload.cwd);
      });
      // Every admitted snapshot starts clean; the edits below must generate
      // distinct dirty transitions for all roots, not unchanged status values.
      covered.clear();
      await Promise.all(paths.map((path) => writeFile(path, "export const x = 3;\n")));
      await until(
        () => roots.every((root) => covered.has(root)),
        "all workspace Git callbacks",
        30_000,
      );
      stop();
      report({
        phase: "daemon-coverage",
        registered: count,
        roundTrips: covered.size,
        metrics: service!.getMetrics(),
      });
      phase = "next-build";
      const nextRoot = process.env.PASEO_WATCH_LOAD_NEXT_ROOT;
      if (!nextRoot)
        throw new Error(
          "PASEO_WATCH_LOAD_NEXT_ROOT must name an installed Next app's node_modules for the build canary",
        );
      const root = roots[0];
      await symlink(resolve(nextRoot), join(root, "node_modules"), "dir").catch(async (error) => {
        if (error.code !== "EEXIST") throw error;
      });
      await mkdir(join(root, "app"), { recursive: true });
      await writeFile(
        join(root, "app", "layout.js"),
        "export default function Layout({children}) { return <html><body>{children}</body></html>; }\n",
      );
      await writeFile(
        join(root, "app", "page.js"),
        "export default function Page() { return <main>Watcher build canary</main>; }\n",
      );
      for (let i = 0; i < 225; i++) {
        const dir = join(root, "app", `page-${i}`);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "page.js"),
          `export default function Page() { return <main>Page ${i}</main>; }\n`,
        );
      }
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "watcher-next-load", private: true }),
      );
      await writeFile(
        join(root, "next.config.mjs"),
        "export default { experimental: { cpus: 2 } };\n",
      );
      // All observers must incorporate new .gitignored output roots before the
      // measurement; the build creates .next only after that barrier.
      await mkdir(join(root, ".next"), { recursive: true });
      await sleep(2_000);
      // Count the same build through a second, intentionally unpruned native
      // stream. This comparison includes identical FSEvents coalescing.
      const control = createFileObserver();
      await control.subscribe(
        root,
        (error) => {
          if (error) throw error;
        },
        { ignore: [join(root, ".git"), join(root, "node_modules")] },
      );
      const controlBefore = control.getDiagnostics().nativeEventCount;
      const before = service!.getMetrics().fileObserver.nativeEventCount;
      const started = performance.now();
      let controlEvents = 0;
      let result;
      try {
        result = await exec(
          "bash",
          [
            "-c",
            'ulimit -S -n 4096; exec "$@"',
            "next-build",
            process.execPath,
            join(resolve(nextRoot), "next", "dist", "bin", "next"),
            "build",
            "--webpack",
          ],
          {
            cwd: root,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
          },
        );
        await writeFile(join(base, "next-build.log"), result.stdout + result.stderr);
        await sleep(500);
      } finally {
        controlEvents = control.getDiagnostics().nativeEventCount - controlBefore;
        await control.close();
      }
      const buildMs = performance.now() - started;
      const nativeEvents = service!.getMetrics().fileObserver.nativeEventCount - before;

      report({
        phase,
        buildMs,
        buildFdLimit: 4096,
        nativeEvents,
        controlEvents,
        controlEventsPerMinute: (controlEvents * 60_000) / buildMs,
        eventsPerMinute: (nativeEvents * 60_000) / buildMs,
        metrics: service!.getMetrics(),
      });
      if (
        controlEvents === 0 ||
        nativeEvents >= controlEvents * 0.2 ||
        service!.getMetrics().fileObserver.observerFailureCount !== 0
      )
        throw new Error("registered build pruning bar failed");
      await events.release();
    } finally {
      phase = "daemon-teardown";
      await client.close();
      await daemon.close();
      capture.mock.restore();
      log.end();
    }
    await sleep(50);
    report({
      phase: "verdict",
      functionalPassed: true,
      maxStallMs,
      eventLoop: eventLoopEvidence(),
      bar: {
        eventLoop: "no regression against a baseline under the same load and window",
        fullCoverage: count,
        coldCheckoutStatusMs: 10_000,
      },
      base,
    });
  } finally {
    histogram.disable();
    clearInterval(heartbeat);
    clearInterval(progress);
  }
}

if (process.argv.includes("--child")) await runChild();
else await parent();
