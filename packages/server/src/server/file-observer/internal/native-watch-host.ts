import { watch } from "node:fs";
import { watchDarwinDirectoryLocal } from "./darwin-local.js";
import type { NativeWatch } from "./native-recursive.js";
import type { WatchHostCommand, WatchHostMessage } from "./native-watch-protocol.js";

interface Entry {
  watcher: Promise<NativeWatch>;
  closing: boolean;
  events: Map<string | null, string>;
  overflow: boolean;
  sending: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<number, Entry>();
const MAX_QUEUED_PATHS = 8192;
const EVENT_BATCH_SIZE = 250;

function send(message: WatchHostMessage, callback?: () => void): void {
  if (process.connected) process.send!(message, () => callback?.());
}

function scheduleFlush(id: number, entry: Entry): void {
  if (entry.closing || entry.timer || entry.sending) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entry.closing) return;
    const events: Array<[string, string | null]> = [];
    if (entry.overflow) {
      entry.overflow = false;
      events.push(["overflow", null]);
    }
    for (const [path, event] of entry.events) {
      events.push([event, path]);
      entry.events.delete(path);
      if (events.length >= EVENT_BATCH_SIZE) break;
    }
    if (events.length) {
      entry.sending = true;
      send({ action: "events", id, events }, () => {
        entry.sending = false;
        if (entry.events.size || entry.overflow) scheduleFlush(id, entry);
      });
    }
  }, 10);
}

function reportError(id: number, error: unknown): void {
  const value = error instanceof Error ? error : new Error(String(error));
  send({
    action: "error",
    id,
    error: { message: value.message, code: (value as NodeJS.ErrnoException).code },
  });
}

async function receive(command: WatchHostCommand): Promise<void> {
  const { id } = command;
  if (command.action === "watch") {
    const listener = (event: string, filename: string | Buffer | null) => {
      const entry = entries.get(id);
      if (!entry || entry.closing) return;
      if (entry.events.size >= MAX_QUEUED_PATHS) {
        entry.events.clear();
        entry.overflow = true;
      }
      entry.events.set(filename === null ? null : filename.toString(), event);
      scheduleFlush(id, entry);
    };
    const { root, kind, ignored } = command.input;
    const entry: Entry = {
      closing: false,
      events: new Map(),
      overflow: false,
      sending: false,
      watcher: Promise.resolve().then(() =>
        kind === "parcel"
          ? watchDarwinDirectoryLocal(root, listener, true, ignored)
          : watch(root, { recursive: false }, listener),
      ),
    };
    entries.set(id, entry);
    try {
      const watcher = await entry.watcher;
      watcher.on("error", (error) => reportError(id, error));
      send({ action: "ready", id });
    } catch (error) {
      reportError(id, error);
    }
  } else {
    const entry = entries.get(id);
    if (entry) {
      entry.closing = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.events.clear();
      try {
        await (await entry.watcher).close();
      } catch (error) {
        reportError(id, error);
      }
      entries.delete(id);
    }
    send({ action: "closed", id });
  }
}

process.on("message", (command: WatchHostCommand) => {
  void receive(command);
});
process.on("disconnect", () => {
  process.exit(0);
});
