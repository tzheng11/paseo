import { nativeWatchHost } from "./native-watch-client.js";
import type { WatchDirectory } from "./native-recursive.js";

export const watchDarwinDirectory: WatchDirectory = async (
  root,
  listener,
  _recursive,
  ignored = [],
) => {
  const watcher = nativeWatchHost.watch({ root, kind: "parcel", ignored }, listener);
  try {
    await watcher.ready;
  } catch (error) {
    await watcher.close();
    throw error;
  }
  return watcher;
};
