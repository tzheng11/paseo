import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resolveWorkerExecArgv } from "./supervisor-worker-config.js";

test.each([
  ["worker.js", []],
  ["worker.ts", ["--import", "tsx"]],
])("unset worker heap preserves the execution arguments for %s", (workerEntry, expected) => {
  expect(resolveWorkerExecArgv({ workerEntry, devMode: false, env: {} })).toEqual(expected);
});

test.each(["1024", "16384", "65536"])("production worker accepts %s MiB", (heapMB) => {
  const env = Object.freeze({
    IMPOWER_PASEO_WORKER_HEAP_MB: heapMB,
    NODE_OPTIONS: "--no-warnings",
  });
  expect(resolveWorkerExecArgv({ workerEntry: "worker.js", devMode: false, env })).toEqual([
    `--max-old-space-size=${heapMB}`,
  ]);
  expect(env).toEqual({ IMPOWER_PASEO_WORKER_HEAP_MB: heapMB, NODE_OPTIONS: "--no-warnings" });
});

test("production TypeScript workers retain their loader before the heap flag", () => {
  expect(
    resolveWorkerExecArgv({
      workerEntry: "worker.ts",
      devMode: false,
      env: { IMPOWER_PASEO_WORKER_HEAP_MB: "16384" },
    }),
  ).toEqual(["--import", "tsx", "--max-old-space-size=16384"]);
});

test.each([undefined, "65536", "invalid"])(
  "packaged runners retain their execution arguments with heap setting %j",
  (heapMB) => {
    expect(
      resolveWorkerExecArgv({
        workerEntry: "worker.js",
        devMode: false,
        env: { IMPOWER_PASEO_WORKER_HEAP_MB: heapMB },
        enableProductionHeap: false,
      }),
    ).toEqual([]);
  },
);

test.each([
  "",
  "1023",
  "65537",
  "-16384",
  "+16384",
  "16GiB",
  "16.5",
  "1e4",
  " 16384",
  "9".repeat(400),
])("invalid production worker heap %j fails before launch", (heapMB) => {
  expect(() =>
    resolveWorkerExecArgv({
      workerEntry: "worker.js",
      devMode: false,
      env: { IMPOWER_PASEO_WORKER_HEAP_MB: heapMB },
    }),
  ).toThrow("IMPOWER_PASEO_WORKER_HEAP_MB must be an integer from 1024 to 65536 MiB");
});

test.each([undefined, "16384", "invalid"])(
  "development keeps its existing flags with production heap setting %j",
  (heapMB) => {
    expect(
      resolveWorkerExecArgv({
        workerEntry: "worker.ts",
        devMode: true,
        env: { IMPOWER_PASEO_WORKER_HEAP_MB: heapMB },
      }),
    ).toEqual([
      "--heapsnapshot-near-heap-limit=3",
      "--max-old-space-size=3072",
      "--report-on-fatalerror",
      "--report-directory=/tmp/paseo-reports",
      "--inspect",
      "--import",
      "tsx",
    ]);
  },
);

test.each(["0", "false", "off"])("development still honors disabled inspector %s", (inspect) => {
  expect(
    resolveWorkerExecArgv({
      workerEntry: "worker.js",
      devMode: true,
      env: { PASEO_NODE_INSPECT: inspect },
    }),
  ).toEqual([
    "--heapsnapshot-near-heap-limit=3",
    "--max-old-space-size=3072",
    "--report-on-fatalerror",
    "--report-directory=/tmp/paseo-reports",
  ]);
});

interface RuntimeReport {
  execArgv: string[];
  nodeOptions: string;
  heapSetting: string;
  heapSizeLimitMiB: number;
  children: { role: string; execArgv: string[]; nodeOptions: string; heapSetting: string }[];
}

async function runHeapFixture(heapMB: string): Promise<{ code: number | null; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worker-heap-"));
  const workerPath = path.join(root, "worker.mjs");
  const descendantPath = path.join(root, "descendant.mjs");
  const runnerPath = path.join(root, "runner.mjs");
  await writeFile(
    descendantPath,
    `console.log(JSON.stringify({ role: process.argv[2], execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, heapSetting: process.env.IMPOWER_PASEO_WORKER_HEAP_MB }));`,
  );
  await writeFile(
    workerPath,
    `
      import { spawnSync } from "node:child_process";
      import { getHeapStatistics } from "node:v8";
      const children = ["provider", "terminal"].map(role => {
        const result = spawnSync(process.execPath, [${JSON.stringify(descendantPath)}, role], { env: process.env, encoding: "utf8" });
        if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
        return JSON.parse(result.stdout);
      });
      const report = { execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, heapSetting: process.env.IMPOWER_PASEO_WORKER_HEAP_MB, heapSizeLimitMiB: getHeapStatistics().heap_size_limit / 1024 ** 2, children };
      process.send({ type: "paseo:ready", listen: "heap-fixture", serverId: "srv_heap_fixture" }, () => {
        process.stdout.write("HEAP_REPORT=" + JSON.stringify(report) + "\\n", () => process.exit(0));
      });
    `,
  );
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(new URL("./supervisor.ts", import.meta.url).href)};
      import { resolveWorkerExecArgv } from ${JSON.stringify(new URL("./supervisor-worker-config.ts", import.meta.url).href)};
      const workerEntry = ${JSON.stringify(workerPath)};
      runSupervisor({ name: "HeapFixture", startupMessage: "heap fixture", resolveWorkerEntry: () => workerEntry, workerEnv: process.env, workerArgs: [], workerExecArgv: resolveWorkerExecArgv({ workerEntry, devMode: false, env: process.env }) });
    `,
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...process.env, NODE_OPTIONS: "--no-warnings", IMPOWER_PASEO_WORKER_HEAP_MB: heapMB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output || "Heap fixture timed out"));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["16384", "65536"])("fork applies %s MiB only to the daemon worker", async (heapMB) => {
  const { code, output } = await runHeapFixture(heapMB);
  expect(code, output).toBe(0);
  const line = output.split("\n").find((candidate) => candidate.startsWith("HEAP_REPORT="));
  expect(line, output).toBeTypeOf("string");
  const report = JSON.parse(line!.slice("HEAP_REPORT=".length)) as RuntimeReport;
  expect(report.execArgv).toEqual([`--max-old-space-size=${heapMB}`]);
  expect(report.nodeOptions).toBe("--no-warnings");
  expect(report.heapSetting).toBe(heapMB);
  expect(report.heapSizeLimitMiB).toBeGreaterThanOrEqual(Number(heapMB));
  expect(report.heapSizeLimitMiB).toBeLessThan(Number(heapMB) + 1024);
  expect(report.children).toEqual(
    ["provider", "terminal"].map((role) => ({
      role,
      execArgv: [],
      nodeOptions: "--no-warnings",
      heapSetting: heapMB,
    })),
  );
});

test("invalid production heap aborts the supervisor before the worker starts", async () => {
  const { code, output } = await runHeapFixture("invalid");
  expect(code).toBe(1);
  expect(output).toContain(
    "IMPOWER_PASEO_WORKER_HEAP_MB must be an integer from 1024 to 65536 MiB",
  );
  expect(output).not.toContain("HEAP_REPORT=");
  expect(output).not.toContain("Spawning worker");
});
