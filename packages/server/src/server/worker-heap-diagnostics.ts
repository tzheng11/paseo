interface WorkerHeapDiagnosticInput {
  execArgv: readonly string[];
  heapSizeLimitBytes: number;
}

interface WorkerHeapDiagnostics {
  maxOldSpaceSizeMiB: number | null;
  heapSizeLimitMiB: number;
}

export function workerHeapDiagnostics({
  execArgv,
  heapSizeLimitBytes,
}: WorkerHeapDiagnosticInput): WorkerHeapDiagnostics {
  let maxOldSpaceSizeMiB: number | null = null;
  for (let index = 0; index < execArgv.length; index++) {
    const argument = execArgv[index]!;
    let value: string | undefined;
    if (argument.startsWith("--max-old-space-size=")) {
      value = argument.slice("--max-old-space-size=".length);
    } else if (argument === "--max-old-space-size") {
      value = execArgv[index + 1];
    }
    if (value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      maxOldSpaceSizeMiB = Number(value);
    }
  }
  return { maxOldSpaceSizeMiB, heapSizeLimitMiB: heapSizeLimitBytes / 1024 ** 2 };
}
