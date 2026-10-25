import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const BACKEND_ENV = "PASEO_DARWIN_WATCH_BACKEND";
export type DarwinWatchBackend = "parcel" | "node";

export function resolveDarwinWatchBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DarwinWatchBackend {
  const value = env[BACKEND_ENV];
  if (value === undefined) return "parcel";
  if (value !== "parcel" && value !== "node") {
    throw new Error(`${BACKEND_ENV} must be parcel or node`);
  }
  if (platform !== "darwin") {
    throw new Error(`${BACKEND_ENV} is only supported on Darwin`);
  }
  return value;
}

export function createDarwinEventPathFilter(options: {
  root: string;
  physicalRoot: string;
  ignored: readonly string[];
}): (filename: string | Buffer | null) => string | null | undefined {
  const root = resolve(options.physicalRoot);
  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const ignored = new Set(
    options.ignored.map((path) => resolve(root, relative(options.root, path))).filter(inside),
  );
  return (filename) => {
    if (ignored.has(root)) return undefined;
    if (filename === null || filename.length === 0) return null;
    const absolute = resolve(root, filename.toString());
    if (!inside(absolute)) return undefined;
    // Walk only this event's ancestors, independent of the number of ignored
    // roots. No filesystem calls or unbounded per-event path cache.
    for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
      if (ignored.has(ancestor)) return undefined;
      if (ancestor === root) break;
    }
    return relative(root, absolute);
  };
}
