import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

async function renameAtomicFile(tempPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || delay == null) throw error;
      const code =
        error !== null && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EPERM" && code !== "EBUSY") throw error;
      // A receipt may already describe dispatched input. Retry only its commit,
      // retaining both the exact temporary bytes and the previous destination.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await renameAtomicFile(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}
