import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceBackingScope {
  paths: readonly string[];
  keys?: readonly string[];
}
interface Lease {
  active: boolean;
  paths: string[];
  keys: Set<string>;
}
interface WaitingLease {
  lease: Lease;
  ready: () => void;
}
const leases = new Set<Lease>();
const waiting: WaitingLease[] = [];
const backingOwner = new AsyncLocalStorage<Lease>();

export function nativeTransitionKey(
  home: string,
  kind: "project" | "workspace",
  id: string,
): string {
  return JSON.stringify([path.resolve(home), kind, id]);
}
export async function canonicalWorkspaceBacking(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalWorkspaceBacking(parent), path.basename(absolute));
  }
}
function childOf(parent: string, child: string): boolean {
  // Missing descendants have no realpath yet. Conservatively coalesce case
  // and Unicode aliases on the supported Mac/Windows volumes.
  const key = (value: string) =>
    process.platform === "darwin" || process.platform === "win32"
      ? value.normalize("NFC").toLowerCase()
      : value;
  const relative = path.relative(key(parent), key(child));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function conflicts(left: Lease, right: Lease): boolean {
  return (
    [...left.keys].some((key) => right.keys.has(key)) ||
    left.paths.some((a) => right.paths.some((b) => childOf(a, b) || childOf(b, a)))
  );
}
function admitWaiting(): void {
  for (const waiter of waiting.slice()) {
    const index = waiting.indexOf(waiter);
    if ([...leases].some((lease) => conflicts(lease, waiter.lease))) continue;
    if (waiting.slice(0, index).some((prior) => conflicts(prior.lease, waiter.lease))) continue;
    waiting.splice(index, 1);
    leases.add(waiter.lease);
    waiter.ready();
  }
}

/** Locks only overlapping physical paths and explicit native identity read sets. */
export async function serializeWorkspaceBacking<T>(
  backing: string | WorkspaceBackingScope,
  run: () => Promise<T>,
): Promise<T> {
  const scope = typeof backing === "string" ? { paths: [backing] } : backing;
  const requested: Lease = {
    active: true,
    paths: [...new Set(await Promise.all(scope.paths.map(canonicalWorkspaceBacking)))],
    keys: new Set(scope.keys),
  };
  const inherited = backingOwner.getStore();
  if (inherited?.active) {
    const extension: Lease = {
      active: true,
      paths: requested.paths.filter(
        (candidate) => !inherited.paths.some((held) => childOf(held, candidate)),
      ),
      keys: new Set([...requested.keys].filter((key) => !inherited.keys.has(key))),
    };
    if (!extension.paths.length && !extension.keys.size) return run();
    // A nested operation may acquire a vacant extension, but never waits while
    // retaining a partial lease: opposite expansions must not deadlock.
    if (
      [...leases].some((lease) => lease !== inherited && conflicts(lease, extension)) ||
      waiting.some((waiter) => conflicts(waiter.lease, extension))
    ) {
      throw new Error("workspace_backing_scope_conflict");
    }
    inherited.paths = [...new Set([...inherited.paths, ...requested.paths])];
    for (const key of requested.keys) inherited.keys.add(key);
    return run();
  }
  await new Promise<void>((ready) => {
    waiting.push({ lease: requested, ready });
    admitWaiting();
  });
  try {
    return await backingOwner.run(requested, run);
  } finally {
    requested.active = false;
    leases.delete(requested);
    admitWaiting();
  }
}
