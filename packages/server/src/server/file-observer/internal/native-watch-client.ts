import { fork, type ChildProcess } from "node:child_process";
import { resolveDarwinWatchBackend } from "./darwin-watch-backend.js";
import type { NativeWatch } from "./native-recursive.js";
import type {
  NativeWatchInput,
  WatchHostCommand,
  WatchHostMessage,
} from "./native-watch-protocol.js";

export interface HostedNativeWatch extends NativeWatch {
  ready: Promise<void>;
  close(): Promise<void>;
}

interface NativeWatchHostOptions {
  entry?: URL;
  timeoutMs?: number;
  fork?: typeof fork;
}

interface Subscription {
  listener: (event: string, filename: string | null) => void;
  onError?: (error: Error) => void;
  error?: Error;
  closing: boolean;
  resolveReady(): void;
  rejectReady(error: Error): void;
  resolveClose: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One process owns all Darwin native watch calls, including nonrecursive ones.
 * A native mutex, stream rebuild or synchronous close cannot stop the daemon loop.
 */
export class NativeWatchHost {
  private child: ChildProcess | null = null;
  private readonly subscriptions = new Map<number, Subscription>();
  private nextId = 0;

  private readonly entry: URL;
  private readonly timeoutMs: number;
  private readonly forkHost: typeof fork;

  constructor(options: NativeWatchHostOptions = {}) {
    // This module is loaded with the observer during daemon startup. Reject a
    // bad deployment setting before it can leave consumers waiting on a child.
    resolveDarwinWatchBackend();
    this.entry =
      options.entry ??
      new URL(
        import.meta.url.endsWith(".ts") ? "./native-watch-host.ts" : "./native-watch-host.js",
        import.meta.url,
      );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.forkHost = options.fork ?? fork;
  }

  watch(input: NativeWatchInput, listener: Subscription["listener"]): HostedNativeWatch {
    const id = ++this.nextId;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Synchronous consumers use on(error); asynchronous consumers await ready.
    void ready.catch(() => undefined);
    let resolveClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const subscription: Subscription = {
      listener,
      closing: false,
      resolveReady,
      rejectReady,
      resolveClose,
      timer: setTimeout(
        () => this.fail(new Error(`Native watch registration timed out: ${input.root}`)),
        this.timeoutMs,
      ),
    };
    this.subscriptions.set(id, subscription);
    this.send({ action: "watch", id, input });
    return {
      ready,
      on: (_event, callback) => {
        subscription.onError = callback;
        if (subscription.error && !subscription.closing) {
          queueMicrotask(() => {
            if (!subscription.closing) callback(subscription.error!);
          });
        }
      },
      close: () => {
        if (subscription.closing) return closed;
        subscription.closing = true;
        if (!this.subscriptions.has(id)) return closed;
        this.setCloseDeadline(subscription, input.root);
        this.send({ action: "close", id });
        return closed;
      },
    };
  }

  private setCloseDeadline(subscription: Subscription, root: string): void {
    clearTimeout(subscription.timer);
    subscription.timer = setTimeout(
      () => this.fail(new Error(`Native watch close timed out: ${root}`)),
      this.timeoutMs,
    );
  }

  private send(command: WatchHostCommand): void {
    try {
      if (!this.child) {
        const child = this.forkHost(this.entry, [], {
          execArgv: this.entry.pathname.endsWith(".ts")
            ? ["--import", import.meta.resolve("tsx")]
            : [],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        this.child = child;
        child.on("message", (message: WatchHostMessage) => this.receive(child, message));
        child.on("error", (error) => {
          if (this.child === child) this.fail(error);
        });
        child.on("exit", (code, signal) => {
          if (this.child === child)
            this.fail(new Error(`Native watch host exited (${code ?? signal})`));
        });
      }
      const child = this.child;
      child.send(command, (error) => {
        if (error && this.child === child) this.fail(error);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(child: ChildProcess, message: WatchHostMessage): void {
    if (this.child !== child) return;
    const subscription = this.subscriptions.get(message.id);
    if (!subscription) return;
    if (message.action === "events") {
      if (!subscription.closing)
        for (const [event, filename] of message.events) subscription.listener(event, filename);
      return;
    }
    if (message.action === "ready") {
      if (!subscription.closing) clearTimeout(subscription.timer);
      subscription.resolveReady();
    } else if (message.action === "closed") {
      clearTimeout(subscription.timer);
      subscription.resolveReady();
      subscription.resolveClose();
      this.subscriptions.delete(message.id);
      if (!this.subscriptions.size) {
        this.child = null;
        child.disconnect();
      }
    } else {
      clearTimeout(subscription.timer);
      const error = Object.assign(new Error(message.error.message), { code: message.error.code });
      subscription.error = error;
      subscription.rejectReady(error);
      if (!subscription.closing) subscription.onError?.(error);
    }
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of subscriptions) {
      clearTimeout(subscription.timer);
      subscription.error = error;
      subscription.rejectReady(error);
    }
    // Kill only our host: a wedged native call cannot service IPC disconnect.
    // Await its exit before resolving native close barriers.
    const closed = () => {
      for (const subscription of subscriptions) subscription.resolveClose();
    };
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.once("exit", closed);
      child.kill("SIGKILL");
    } else closed();
    for (const subscription of subscriptions)
      if (!subscription.closing) subscription.onError?.(error);
  }
}

export const nativeWatchHost = new NativeWatchHost();
