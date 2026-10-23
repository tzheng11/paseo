interface WorkerExecArgvOptions {
  workerEntry: string;
  devMode: boolean;
  env: NodeJS.ProcessEnv;
  enableProductionHeap?: boolean;
}

export function resolveWorkerExecArgv({
  workerEntry,
  devMode,
  env,
  enableProductionHeap = true,
}: WorkerExecArgvOptions): string[] {
  const execArgv = workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
  if (!devMode) {
    if (!enableProductionHeap) return execArgv;
    const heapMB = env.IMPOWER_PASEO_WORKER_HEAP_MB;
    if (heapMB === undefined) return execArgv;
    const heap = Number(heapMB);
    if (!/^\d+$/.test(heapMB) || heap < 1024 || heap > 65536) {
      throw new Error("IMPOWER_PASEO_WORKER_HEAP_MB must be an integer from 1024 to 65536 MiB");
    }
    return [...execArgv, `--max-old-space-size=${heap}`];
  }
  const devArgs = [
    "--heapsnapshot-near-heap-limit=3",
    "--max-old-space-size=3072",
    "--report-on-fatalerror",
    "--report-directory=/tmp/paseo-reports",
  ];
  const inspectArg = env.PASEO_NODE_INSPECT ?? "--inspect";
  if (inspectArg !== "0" && inspectArg !== "false" && inspectArg !== "off") {
    devArgs.push(inspectArg);
  }
  return [...devArgs, ...execArgv];
}
