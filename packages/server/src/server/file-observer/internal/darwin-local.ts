import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WatchDirectory } from "./native-recursive.js";
import { createDarwinEventPathFilter, resolveDarwinWatchBackend } from "./darwin-watch-backend.js";

// Validate again in the native child, before accepting any watch commands.
const backend = resolveDarwinWatchBackend();

// Loaded only in the native watcher child, never on the daemon event loop.
export const watchDarwinDirectoryLocal: WatchDirectory = async (
  root,
  listener,
  _recursive,
  ignored = [],
) => {
  // FSEvents reports physical paths (e.g. /private/var for /var). Resolve once
  // at admission, then keep consumers and ignores in their lexical namespace.
  const physicalRoot = await realpath(root);
  if (backend === "node") {
    const filter = createDarwinEventPathFilter({ root, physicalRoot, ignored });
    let closing = false;
    let closed = false;
    let onError: ((error: Error) => void) | undefined;
    let pendingError: Error | undefined;
    let resolveClosed!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const watcher = watch(physicalRoot, { recursive: true }, (event, filename) => {
      if (closing || closed) return;
      const path = filter(filename);
      if (path !== undefined) listener(event, path);
    });
    watcher.once("close", () => {
      closed = true;
      resolveClosed();
    });
    watcher.on("error", (error) => {
      if (closing) return;
      if (onError) onError(error);
      else pendingError = error;
    });
    return {
      close: () => {
        closing = true;
        watcher.close();
        return closeBarrier;
      },
      on: (_event, callback) => {
        onError = callback;
        if (pendingError) {
          queueMicrotask(() => {
            if (!closing) callback(pendingError!);
          });
        }
      },
    };
  }

  const { subscribe } = await import("@parcel/watcher");
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
