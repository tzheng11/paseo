import { readdir, rm } from "node:fs/promises";
import path from "node:path";

/** A cache survives SIGKILL; remove it only after its owning process has exited. */
export async function pruneAbandonedHistoryCaches(
  directory: string,
  prefix: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const owner = /^(\d+)-/.exec(entry.name.slice(prefix.length));
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        await rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
}
