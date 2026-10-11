import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WatchDirectory } from "./native-recursive.js";

// Parcel starts/stops FSEvents on its native async workers. fs.watch.close()
// waits synchronously for libuv's shared FSEvents stream to be recreated.
export const watchDarwinDirectory: WatchDirectory = async (
  root,
  listener,
  _recursive,
  ignored = [],
) => {
  const { subscribe } = await import("@parcel/watcher");
  // FSEvents reports physical paths (e.g. /private/var for /var). Resolve once
  // at admission, then keep consumers and ignores in their lexical namespace.
  const physicalRoot = await realpath(root);
  let onError: ((error: Error) => void) | undefined;
  let pendingError: Error | undefined;
  const subscription = await subscribe(
    physicalRoot,
    (error, events) => {
      if (error && isOverflow(error)) {
        // FSEvents coalesces/drops paths under bursts. The retained inventory
        // reconciles the whole root; resource/permission errors still fail.
        listener("overflow", null);
        return;
      }
      if (error) {
        if (onError) onError(error);
        else pendingError = error;
        return;
      }
      for (const event of events) {
        listener(event.type === "update" ? "change" : "rename", relative(physicalRoot, event.path));
      }
    },
    {
      backend: "fs-events",
      ignore: ignored.map((path) => literalIgnore(join(physicalRoot, relative(root, path)))),
    },
  );
  return {
    close: () => subscription.unsubscribe(),
    on: (_event, callback) => {
      onError = callback;
      if (pendingError) queueMicrotask(() => callback(pendingError!));
    },
  };
};

function literalIgnore(path: string): string | RegExp {
  // The public wrapper interprets glob characters. Git paths are literal even
  // when a directory is named "[draft]". Preserve native path exclusions for
  // ordinary paths and use a literal subtree regex for those special names.
  if (!/[!*?{}()[\]]/.test(path)) return path;
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`);
}

function isOverflow(error: Error): boolean {
  return [
    "Events were dropped by the FSEvents client. File system must be re-scanned.",
    "Events were dropped by the kernel. File system must be re-scanned.",
    "Too many events. File system must be re-scanned.",
  ].includes(error.message);
}
