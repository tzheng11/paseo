import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DaemonRequestNotSentError,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import {
  WorkspaceLayoutSnapshotSchema,
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutReceiptSchema,
  type WorkspaceLayoutConfig,
  type WorkspaceLayoutIdentity,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutCommit,
  type WorkspaceLayoutReceipt,
} from "@getpaseo/protocol/workspace-layout";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  WorkspaceLayoutStore,
  WorkspaceLayoutRefusal,
  canonicalLayoutJson,
  hashLayoutValue,
  projectConfirmedLayout,
} from "./workspace-layout-store.js";

export interface WorkspaceLayoutTransport {
  use<T>(action: (client: DaemonClient) => Promise<T>, signal?: AbortSignal): Promise<T>;
  changed(listener: () => void): () => void;
}

interface LayoutServiceOptions {
  home: string;
  serverId: string;
  config: WorkspaceLayoutConfig;
  failed(error: unknown): void;
}

/** Canonical writes or identity-bound forwarding; the cache never accepts a write. */
export class WorkspaceLayoutService {
  private readonly store: WorkspaceLayoutStore | null;
  private cache: WorkspaceLayoutSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private transport: WorkspaceLayoutTransport | null = null;
  private readonly lifetime = new AbortController();
  private watching: Promise<void> | null = null;
  private stopTransport: (() => void) | undefined;
  private cacheQueue: Promise<unknown> = Promise.resolve();
  private connected = false;
  private healthy = false;
  private observationRestartRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  constructor(readonly options: LayoutServiceOptions) {
    this.store =
      options.config.role === "authority"
        ? new WorkspaceLayoutStore({
            paseoHome: options.home,
            identity: options.config,
            serverId: options.serverId,
          })
        : null;
    if (!this.store && options.serverId === options.config.authorityServerId)
      throw new WorkspaceLayoutRefusal("replica_is_authority");
  }

  async load(): Promise<void> {
    if (this.store) {
      try {
        await this.inspect();
      } catch (error) {
        if (!(error instanceof WorkspaceLayoutRefusal) || error.code !== "not_initialized")
          throw error;
      }
      return;
    }
    try {
      const snapshot = WorkspaceLayoutSnapshotSchema.parse(
        JSON.parse(await readFile(this.cachePath(), "utf8")),
      );
      this.assertIdentity(snapshot.stamp);
      this.cache = snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.options.failed(new WorkspaceLayoutRefusal("replica_cache_unreadable"));
      // The authority is still identity-pinned. A damaged protection replica
      // must not prevent obtaining a fresh snapshot or become an authority.
      this.cache = null;
      this.healthy = false;
    }
  }

  attachTransport(transport: WorkspaceLayoutTransport): void {
    if (this.store || this.transport) return;
    this.transport = transport;
    this.stopTransport = transport.changed(() => this.startObservation());
    this.startObservation();
  }

  cached(): { snapshot: WorkspaceLayoutSnapshot | null; fresh: boolean } {
    return {
      snapshot: structuredClone(this.cache),
      fresh: this.healthy && (this.store !== null || this.connected),
    };
  }

  status() {
    return {
      ...this.options.config,
      stamp: this.cache?.stamp ?? null,
      synchronized: this.cached().fresh,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async inspect(): Promise<WorkspaceLayoutSnapshot> {
    const knownRevision = this.cache?.stamp.revision ?? 0;
    try {
      const snapshot = this.store
        ? await this.store.inspect()
        : await this.remote((client) => client.getWorkspaceLayout());
      await this.accept(snapshot, knownRevision);
      return structuredClone(this.cache ?? snapshot);
    } catch (error) {
      this.healthy = false;
      this.changed();
      throw error;
    }
  }

  async initialize(identity: WorkspaceLayoutIdentity): Promise<WorkspaceLayoutSnapshot> {
    if (!this.store) throw new WorkspaceLayoutRefusal("initialize_on_authority_only");
    const snapshot = await this.store.initialize(identity);
    await this.accept(snapshot);
    return snapshot;
  }

  async findReceipt(mutationRequestId: string): Promise<WorkspaceLayoutReceipt | null> {
    const result = this.store
      ? await this.store.findReceipt(mutationRequestId)
      : await this.remote((client) => client.getWorkspaceLayoutReceipt(mutationRequestId));
    if (result === null) return null;
    const receipt = WorkspaceLayoutReceiptSchema.parse(result);
    this.assertIdentity(receipt.stamp);
    if (receipt.requestId !== mutationRequestId)
      throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
    return receipt;
  }

  async commit(raw: WorkspaceLayoutCommit): Promise<WorkspaceLayoutReceipt> {
    const input = WorkspaceLayoutCommitSchema.parse(raw);
    this.assertIdentity(input.expected);
    let receipt: WorkspaceLayoutReceipt;
    if (this.store) receipt = await this.store.commit(input);
    else receipt = await this.forwardCommit(input);
    this.assertIdentity(receipt.stamp);
    if (receipt.requestId !== input.requestId || receipt.requestSha256 !== hashLayoutValue(input))
      throw new WorkspaceLayoutRefusal("invalid_commit_receipt");
    const confirmed = this.cache ? projectConfirmedLayout(this.cache, input, receipt) : null;
    if (confirmed) await this.accept(confirmed, input.expected.revision);
    try {
      await this.inspect();
    } catch (error) {
      // The authority already acknowledged a durable receipt. Failure to refresh
      // the protection replica is stale observation, not a failed mutation.
      this.options.failed(error);
    }
    return receipt;
  }

  private async forwardCommit(input: WorkspaceLayoutCommit): Promise<WorkspaceLayoutReceipt> {
    let entered = false;
    try {
      return await this.remote(async (client) => {
        entered = true;
        return (await client.commitWorkspaceLayout(input)).receipt;
      });
    } catch (error) {
      if (!entered || error instanceof DaemonRequestNotSentError)
        throw new WorkspaceLayoutRefusal("authority_request_not_sent");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopTransport?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.lifetime.abort();
    await this.watching;
    await this.cacheQueue;
    this.listeners.clear();
  }

  private remote<T>(action: (client: DaemonClient) => Promise<T>): Promise<T> {
    if (!this.transport || this.lifetime.signal.aborted)
      return Promise.reject(new WorkspaceLayoutRefusal("authority_unreachable"));
    return this.transport.use(action, this.lifetime.signal);
  }

  private cachePath(): string {
    return path.join(this.options.home, "workspace-layout-replica.json");
  }

  private assertIdentity(identity: WorkspaceLayoutIdentity): void {
    const expected = this.options.config;
    if (
      identity.authorityServerId !== expected.authorityServerId ||
      identity.authorityId !== expected.authorityId ||
      identity.epoch !== expected.epoch
    )
      throw new WorkspaceLayoutRefusal("authority_identity_mismatch");
  }

  private accept(raw: WorkspaceLayoutSnapshot, readStartedAtRevision?: number): Promise<void> {
    const snapshot = WorkspaceLayoutSnapshotSchema.parse(raw);
    this.assertIdentity(snapshot.stamp);
    const result = this.cacheQueue.then(async () => {
      if (this.cache && snapshot.stamp.revision < this.cache.stamp.revision) {
        if (readStartedAtRevision !== undefined && snapshot.stamp.revision >= readStartedAtRevision)
          return;
        throw new WorkspaceLayoutRefusal("authority_revision_regressed");
      }
      if (this.cache && snapshot.stamp.revision === this.cache.stamp.revision) {
        if (canonicalLayoutJson(snapshot) !== canonicalLayoutJson(this.cache))
          throw new WorkspaceLayoutRefusal("authority_revision_fork");
        if (!this.store && !this.healthy) {
          try {
            await writeJsonFileAtomic(this.cachePath(), snapshot);
          } catch (error) {
            this.options.failed(error);
            return;
          }
        }
        this.healthy = true;
        return undefined;
      }
      let persisted = true;
      if (!this.store) {
        try {
          await writeJsonFileAtomic(this.cachePath(), snapshot);
        } catch (error) {
          persisted = false;
          this.options.failed(error);
        }
      }
      this.cache = structuredClone(snapshot);
      this.healthy = persisted;
      this.changed();
      return undefined;
    });
    this.cacheQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private startObservation(): void {
    if (!this.transport || this.lifetime.signal.aborted) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watching) {
      this.observationRestartRequested = true;
      return;
    }
    this.watching = this.observe()
      .catch((error) => {
        if (!this.lifetime.signal.aborted) this.options.failed(error);
      })
      .finally(() => {
        this.connected = false;
        this.watching = null;
        this.changed();
        const restart = this.observationRestartRequested;
        this.observationRestartRequested = false;
        if (restart) this.startObservation();
        else if (!this.lifetime.signal.aborted) this.scheduleObservationRetry();
      });
  }

  private scheduleObservationRetry(): void {
    const delay = Math.min(250 * 2 ** Math.min(this.retryCount++, 7), 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startObservation();
    }, delay);
    this.retryTimer.unref();
  }

  private async observe(): Promise<void> {
    await this.remote(async (client) => {
      const observation = client.observeWorkspaceLayout();
      let fail!: (error: unknown) => void;
      const ended = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const stop = observation.subscribe({
        snapshot: (snapshot) => {
          void this.accept(snapshot).catch(fail);
        },
        update: (message) => {
          if (message.type === "workspace.layout.changed")
            void this.accept(message.payload.snapshot).catch(fail);
        },
        error: fail,
      });
      const disconnected = client.subscribeConnectionStatus((state) => {
        if (state.status === "disconnected")
          fail(new WorkspaceLayoutRefusal("authority_unreachable"));
      });
      const abort = () => fail(new WorkspaceLayoutRefusal("replication_closed"));
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      try {
        const snapshot = await Promise.race([observation.ready, ended]);
        await this.accept(snapshot);
        this.connected = true;
        this.retryCount = 0;
        this.changed();
        if (this.lifetime.signal.aborted) abort();
        await ended;
      } finally {
        this.lifetime.signal.removeEventListener("abort", abort);
        disconnected();
        stop();
        await observation.release();
      }
    });
  }
}

export async function createWorkspaceLayoutService(
  home: string,
  serverId: string,
  config: WorkspaceLayoutConfig | undefined,
  failed: (error: unknown) => void,
): Promise<WorkspaceLayoutService | undefined> {
  if (!config) return undefined;
  const service = new WorkspaceLayoutService({ home, serverId, config, failed });
  await service.load();
  return service;
}
