import { z } from "zod";
import {
  WorkspaceLayoutConfigSchema,
  WorkspaceLayoutSnapshotSchema,
  WorkspaceLayoutCommitSchema,
  WorkspaceLayoutReceiptSchema,
  WorkspaceNavigationPreferencesSchema,
  canonicalLayoutJson,
  type WorkspaceLayoutConfig,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutMutation,
  type WorkspaceLayoutReceipt,
  type WorkspaceNavigationPreferences,
} from "@getpaseo/protocol/workspace-layout";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export const CANONICAL_SIDEBAR_REPLICA_KEY = "canonical-sidebar-layout-replica-v1";
type LayoutClient = Pick<
  DaemonClient,
  | "getWorkspaceLayout"
  | "commitWorkspaceLayout"
  | "getWorkspaceLayoutReceipt"
  | "observeWorkspaceLayout"
>;
interface Peer {
  client: LayoutClient;
  config: WorkspaceLayoutConfig;
}
const PendingSchema = z.object({
  input: WorkspaceLayoutCommitSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ReplicaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  config: WorkspaceLayoutConfigSchema,
  snapshot: WorkspaceLayoutSnapshotSchema.nullable(),
  pending: PendingSchema.nullable(),
  minimumRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
type Replica = z.infer<typeof ReplicaSchema>;
export interface CanonicalSidebarState {
  loaded: boolean;
  enabled: boolean;
  snapshot: WorkspaceLayoutSnapshot | null;
  writable: boolean;
  pending: boolean;
  saving: boolean;
  error: string | null;
}
interface Dependencies {
  read(): Promise<string | null>;
  write(bytes: string): Promise<void>;
  hash(bytes: string): Promise<string>;
  requestId(): string;
  changed(state: CanonicalSidebarState): void;
}

/** A read replica and one journaled intent. It never becomes a layout authority or retries a write. */
export class CanonicalSidebarLayout {
  readonly ready: Promise<void>;
  private replica: Replica | null = null;
  private readonly peers = new Map<string, Peer>();
  private observation: { peer: Peer; stop(): void; release(): Promise<void> } | null = null;
  private observed: WorkspaceLayoutSnapshot | null = null;
  private loaded = false;
  private fresh = false;
  private busy = false;
  private error: string | null = null;
  private loadFailed = false;
  private persistence: Promise<void> = Promise.resolve();
  private releasing: Promise<void> = Promise.resolve();
  private observationGeneration = 0;

  constructor(private readonly deps: Dependencies) {
    this.ready = this.load();
  }

  state(): CanonicalSidebarState {
    return {
      loaded: this.loaded,
      enabled: this.replica !== null || this.peers.size > 0 || this.loadFailed,
      snapshot: this.replica?.snapshot ?? null,
      writable:
        this.fresh &&
        !this.busy &&
        !this.error &&
        !this.replica?.pending &&
        this.replica?.snapshot?.stamp.phase === "active" &&
        !!this.replica.snapshot.navigation,
      pending: this.replica?.pending != null,
      saving: this.busy,
      error: this.error,
    };
  }

  async attach(
    serverId: string,
    client: LayoutClient,
    raw: WorkspaceLayoutConfig,
  ): Promise<() => void> {
    await this.ready;
    if (this.loadFailed) throw new Error(this.error!);
    const peer = { client, config: WorkspaceLayoutConfigSchema.parse(raw) };
    this.peers.set(serverId, peer);
    if (!this.replica) {
      this.replica = { schemaVersion: 1, config: peer.config, snapshot: null, pending: null };
      try {
        await this.persist();
      } catch (error) {
        this.error = "The shared-layout replica could not be saved. Editing is read-only.";
        this.publish();
        throw error;
      }
    }
    this.selectRoute();
    return () => {
      if (this.peers.get(serverId) !== peer) return;
      this.peers.delete(serverId);
      this.selectRoute();
    };
  }

  /** All mutations use the last displayed CAS; no fresh-read rebase can overwrite an intervening layout. */
  async update(
    change: (current: WorkspaceNavigationPreferences) => WorkspaceNavigationPreferences,
  ): Promise<void> {
    return this.mutate((snapshot) => {
      const preferences = WorkspaceNavigationPreferencesSchema.parse(
        change(structuredClone(snapshot.navigation!.preferences)),
      );
      if (
        canonicalLayoutJson(preferences) === canonicalLayoutJson(snapshot.navigation!.preferences)
      )
        return [];
      return [
        { kind: "put-navigation", expectedRevision: snapshot.navigation!.revision, preferences },
      ];
    });
  }

  async mutate(
    build: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceLayoutMutation[],
  ): Promise<void> {
    await this.ready;
    if (!this.state().writable || !this.observation || !this.replica?.snapshot?.navigation)
      throw new Error(this.error ?? "Shared layout is read-only until its authority reconnects.");
    const peer = this.observation.peer;
    const snapshot = this.replica.snapshot;
    const mutations = build(structuredClone(snapshot));
    if (!mutations.length) return;
    if (mutations.some((mutation) => mutation.kind !== "put" && mutation.kind !== "put-navigation"))
      throw new Error("Client layout edits cannot initialize, import or activate the authority.");
    const input = WorkspaceLayoutCommitSchema.parse({
      requestId: this.deps.requestId(),
      expected: snapshot.stamp,
      mutations,
    });
    this.busy = true;
    this.publish();
    let pending: z.infer<typeof PendingSchema>;
    try {
      pending = { input, sha256: await this.deps.hash(canonicalLayoutJson(input)) };
      this.replica.pending = pending;
      // Persist the original input before dispatch. Storage failure sends nothing.
      await this.persist();
    } catch (error) {
      this.busy = false;
      this.error = "Shared layout intent could not be saved. No change was sent.";
      this.publish();
      throw error;
    }
    try {
      const response = await peer.client.commitWorkspaceLayout(input);
      await this.confirm(response.receipt, pending);
    } catch (error) {
      this.fresh = false;
      if (isDefiniteCasRefusal(error)) {
        this.replica.pending = null;
        this.error = "Shared layout changed in another client. Refresh before trying again.";
        try {
          await this.persist();
        } catch (storageError) {
          this.replica.pending = pending;
          this.error = "The refused layout intent could not be retired. Recovery is required.";
          throw storageError;
        }
      } else {
        this.error = "The shared layout change needs a receipt check before another edit.";
      }
      throw error;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  /** Only reads an existing receipt; missing/unknown outcomes never cause redispatch. */
  async reconcile(): Promise<void> {
    await this.ready;
    if (this.busy) throw new Error("Wait for the current shared layout change to finish.");
    // Refresh repairs a failed subscription as well as its one-shot read.
    this.stopObservation();
    this.selectRoute();
    const peer = this.observation?.peer;
    if (!peer) throw new Error("Reconnect a host to check the shared layout.");
    const pending = this.replica?.pending;
    if (pending) {
      const receipt = await peer.client.getWorkspaceLayoutReceipt(pending.input.requestId);
      if (!receipt)
        throw new Error("No durable receipt is available. The original change remains unresolved.");
      await this.confirm(receipt, pending);
    }
    await this.accept(peer, await peer.client.getWorkspaceLayout());
  }

  async close(): Promise<void> {
    this.peers.clear();
    this.stopObservation();
    this.fresh = false;
    await this.releasing;
    await this.persistence;
  }

  private async confirm(
    raw: WorkspaceLayoutReceipt,
    pending: z.infer<typeof PendingSchema>,
  ): Promise<void> {
    const receipt = WorkspaceLayoutReceiptSchema.parse(raw);
    this.requireIdentity(receipt.stamp);
    if (receipt.requestId !== pending.input.requestId || receipt.requestSha256 !== pending.sha256)
      throw new Error("Shared layout receipt does not match the original change.");
    if (
      receipt.stamp.revision !== pending.input.expected.revision + 1 ||
      receipt.stamp.phase !== pending.input.expected.phase
    )
      throw new Error("Shared layout receipt has an unexpected revision.");
    const previousMinimum = this.replica!.minimumRevision;
    this.replica!.minimumRevision = Math.max(previousMinimum ?? 0, receipt.stamp.revision);
    this.replica!.pending = null;
    try {
      await this.persist();
    } catch (error) {
      this.replica!.pending = pending;
      this.replica!.minimumRevision = previousMinimum;
      throw error;
    }
    this.error = null;
    const peer = this.observation?.peer;
    try {
      if (peer) await this.accept(peer, await peer.client.getWorkspaceLayout());
    } catch {
      this.fresh = false;
      this.error = "The layout change was saved. Refresh its read-only replica to continue.";
    }
  }

  private async load(): Promise<void> {
    try {
      const bytes = await this.deps.read();
      if (bytes !== null) {
        this.replica = ReplicaSchema.parse(JSON.parse(bytes));
        if (this.replica.snapshot) this.requireIdentity(this.replica.snapshot.stamp);
        if (this.replica.pending) {
          this.requireIdentity(this.replica.pending.input.expected);
          if (
            (await this.deps.hash(canonicalLayoutJson(this.replica.pending.input))) !==
            this.replica.pending.sha256
          )
            throw new Error("Invalid retained layout intent");
        }
      }
    } catch {
      // Keep the original bytes; corrupt replica state cannot select legacy writes.
      this.error = "Saved shared layout could not be verified. Recovery is required.";
      this.loadFailed = true;
    } finally {
      this.loaded = true;
      this.publish();
    }
  }

  private selectRoute(): void {
    const config = this.replica?.config;
    if (!config) return;
    for (const peer of this.peers.values()) {
      if (!sameAuthority(config, peer.config)) {
        this.fresh = false;
        this.error = "Connected hosts disagree about the shared layout authority.";
        this.stopObservation();
        this.publish();
        return;
      }
    }
    const peer = [...this.peers.values()][0];
    if (peer === this.observation?.peer) return;
    this.stopObservation();
    this.fresh = false;
    if (!peer) {
      this.publish();
      return;
    }
    const subscription = peer.client.observeWorkspaceLayout();
    const generation = this.observationGeneration;
    const failed = (error: unknown) => {
      if (generation === this.observationGeneration) this.observationFailed(error);
    };
    const stop = subscription.subscribe({
      snapshot: (snapshot) => {
        void this.accept(peer, snapshot, generation).catch(failed);
      },
      update: (message) => {
        if (message.type === "workspace.layout.changed")
          void this.accept(peer, message.payload.snapshot, generation).catch(failed);
      },
      error: failed,
    });
    this.observation = { peer, stop, release: () => subscription.release() };
    void subscription.ready
      .then((snapshot) => this.accept(peer, snapshot, generation))
      .catch(failed);
    this.publish();
  }

  private async accept(
    peer: Peer,
    raw: WorkspaceLayoutSnapshot,
    generation = this.observationGeneration,
  ): Promise<void> {
    if (
      this.observation?.peer !== peer ||
      generation !== this.observationGeneration ||
      !this.replica
    )
      return;
    const snapshot = this.usableSnapshot(raw);
    if (!snapshot) return;
    this.observed = snapshot;
    this.replica.snapshot = snapshot;
    await this.persist();
    if (
      this.observation?.peer !== peer ||
      generation !== this.observationGeneration ||
      this.observed !== snapshot
    )
      return;
    this.fresh = true;
    this.error = this.replica.pending
      ? "The previous shared layout change needs a receipt check."
      : null;
    this.publish();
  }

  private usableSnapshot(raw: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot | null {
    if (!this.replica) return null;
    const snapshot = WorkspaceLayoutSnapshotSchema.parse(raw);
    this.requireIdentity(snapshot.stamp);
    const prior = this.replica.snapshot;
    if (prior && snapshot.stamp.revision < prior.stamp.revision) return null;
    if (snapshot.stamp.revision < (this.replica.minimumRevision ?? 0))
      throw new Error("The saved shared-layout revision has not been observed yet.");
    if (
      prior &&
      snapshot.stamp.revision === prior.stamp.revision &&
      canonicalLayoutJson(prior) !== canonicalLayoutJson(snapshot)
    )
      throw new Error("Shared layout revision conflicts with its saved replica.");
    if (
      snapshot.stamp.phase === "active" &&
      (!snapshot.navigation?.preferences.workspaceSort || !snapshot.clientImports)
    )
      throw new Error("Update this host to use the complete shared layout.");
    return snapshot;
  }

  private requireIdentity(value: {
    authorityServerId: string;
    authorityId: string;
    epoch: string;
  }): void {
    if (!this.replica || !sameAuthority(this.replica.config, value))
      throw new Error("Shared layout identity or epoch changed.");
  }
  private persist(): Promise<void> {
    const bytes = JSON.stringify(ReplicaSchema.parse(this.replica));
    const run = this.persistence.catch(() => {}).then(() => this.deps.write(bytes));
    this.persistence = run;
    return run;
  }
  private stopObservation(): void {
    const generation = ++this.observationGeneration;
    const current = this.observation;
    this.observation = null;
    current?.stop();
    if (current) {
      this.releasing = current.release();
      void this.releasing.catch((error) => {
        if (generation === this.observationGeneration) this.observationFailed(error);
      });
    }
  }
  private observationFailed(_error: unknown): void {
    this.fresh = false;
    this.error = "Shared layout is read-only. Reconnect or refresh its authority.";
    this.publish();
  }
  private publish(): void {
    this.deps.changed(this.state());
  }
}

function sameAuthority(
  a: WorkspaceLayoutConfig,
  b: { authorityServerId: string; authorityId: string; epoch: string; authorityKeySha256?: string },
): boolean {
  return (
    a.authorityServerId === b.authorityServerId &&
    a.authorityId === b.authorityId &&
    a.epoch === b.epoch &&
    (b.authorityKeySha256 === undefined || a.authorityKeySha256 === b.authorityKeySha256)
  );
}
function isDefiniteCasRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "stale_revision" || error.code === "stale_navigation_revision")
  );
}
