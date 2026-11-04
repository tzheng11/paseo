import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await replaceFile(tempPath, filePath, operations);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), operations);
}

/** Use for acknowledged authority revisions; ordinary caches need only atomic replacement. */
export async function writeFileDurably(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    await fs.rename(temporary, filePath);
    // Windows cannot flush a directory opened for reading; file data is synced.
    if (process.platform === "win32") return;
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    try {
      await file.close();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
