import { createHash } from "node:crypto";
import type { CredentialChange } from "./quota-turn-recovery.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AgentReloadOperationSchema, type AgentReloadOperation } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

export type ReloadOperation = AgentReloadOperation;

/** Durable receipts outlive sockets. A pending receipt from another process is never replayed. */
export class ReloadOperationStore {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private readonly held = new Map<string, ReloadOperation>();
  private initialized?: Promise<void>;
  private ready = false;

  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
    private readonly options: { completionTimeoutMs?: number } = {},
  ) {}

  start(
    agentId: string,
    operationId: string,
    run: () => Promise<ReloadOperation["continuation"] | void>,
    change?: CredentialChange,
  ): Promise<ReloadOperation> {
    return this.serialize(async () => {
      await this.initialize();
      const existing = await this.read(operationId);
      if (existing) {
        if (
          existing.agentId !== agentId ||
          existing.credentialGeneration !== change?.credentialGeneration ||
          existing.credentialChangedAt !== change?.credentialChangedAt
        )
          throw new Error("reload_operation_conflict");
        return this.reconcile(existing);
      }
      const operation: ReloadOperation = { operationId, agentId, status: "pending", ...change };
      await this.write(operation);
      this.active.add(operationId);
      // Admission is committed before any provider can be closed. Completion writes
      // its receipt before releasing the operation, even after the initiating socket leaves.
      void this.complete(operation, run);
      return operation;
    });
  }

  get(operationId: string): Promise<ReloadOperation | null> {
    return this.serialize(async () => {
      await this.initialize();
      const operation = await this.read(operationId);
      return operation ? this.reconcile(operation) : null;
    });
  }

  async assertWriterAdmission(agentId: string): Promise<void> {
    await this.initialize();
    this.assertWriterAdmissionSync(agentId);
  }

  assertWriterAdmissionSync(agentId: string): void {
    if (
      !this.ready ||
      [...this.held.values()].some(
        (op) => op.agentId === agentId && !this.active.has(op.operationId),
      )
    )
      throw Object.assign(
        new Error(
          "An unresolved credential reload owns this agent; reconcile its original receipt before starting a writer",
        ),
        { code: "agent_reload_in_progress" },
      );
  }

  private initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      let files: string[];
      try {
        files = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
        else throw error;
      }
      for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        const operation = AgentReloadOperationSchema.parse(
          JSON.parse(await readFile(join(this.directory, file), "utf8")),
        );
        if (this.path(operation.operationId) !== join(this.directory, file))
          throw new Error("Reload receipt identity mismatch");
        this.index(operation);
      }
      this.ready = true;
    })());
  }

  private index(operation: ReloadOperation): void {
    if (
      operation.status === "pending" ||
      (operation.status === "unknown" && operation.reasonCode !== "QUOTA_CONTINUATION_UNKNOWN")
    )
      this.held.set(operation.operationId, operation);
    else this.held.delete(operation.operationId);
  }

  private async complete(
    operation: ReloadOperation,
    run: () => Promise<ReloadOperation["continuation"] | void>,
  ): Promise<void> {
    // Bound the observable acknowledgement, not the provider's ownership. A late
    // success must still commit, and retries must not start a competing writer.
    const timer = setTimeout(() => {
      void this.serialize(async () => {
        const current = await this.read(operation.operationId);
        if (!this.active.has(operation.operationId) || current?.status !== "pending") return;
        await this.write({
          ...operation,
          status: "unknown",
          reason: "reload_completion_unconfirmed",
          reasonCode: "RELOAD_COMPLETION_UNCONFIRMED",
          retryable: false,
        });
      }).catch((err) =>
        this.logger.error(
          { err, operationId: operation.operationId },
          "Reload acknowledgement deadline persistence failed",
        ),
      );
    }, this.options.completionTimeoutMs ?? 45_000);
    timer.unref();
    let result: ReloadOperation;
    try {
      const continuation = await run();
      result = {
        ...operation,
        status: continuation?.status === "unknown" ? "unknown" : "completed",
        ...(continuation ? { continuation } : {}),
        ...(continuation?.status === "unknown"
          ? { reasonCode: "QUOTA_CONTINUATION_UNKNOWN", retryable: false }
          : {}),
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      const refused = code === "agent_reload_busy" || code === "agent_reload_unavailable";
      const uncertain =
        code === "reload_cleanup_unconfirmed" ||
        code === "reload_startup_unconfirmed" ||
        code === "reload_registration_unconfirmed";
      let status: ReloadOperation["status"] = "failed";
      if (refused) status = "refused";
      if (uncertain) status = "unknown";
      result = {
        ...operation,
        status,
        reason: typeof code === "string" ? code : "reload_failed",
        reasonCode: typeof code === "string" ? code.toUpperCase() : "RELOAD_FAILED",
        retryable: refused && code === "agent_reload_busy",
      };
    }
    try {
      await this.serialize(() => this.write(result));
    } catch (error) {
      // The durable pending marker remains authoritative. Its next read becomes
      // unknown rather than acknowledging a result that did not reach storage.
      this.logger.error(
        { err: error, operationId: operation.operationId },
        "Reload receipt persistence failed",
      );
    } finally {
      clearTimeout(timer);
      this.active.delete(operation.operationId);
    }
  }

  private async reconcile(operation: ReloadOperation): Promise<ReloadOperation> {
    if (operation.status !== "pending" || this.active.has(operation.operationId)) return operation;
    const unknown: ReloadOperation = {
      ...operation,
      status: "unknown",
      reason: "daemon_restarted_or_receipt_uncommitted",
      reasonCode: "DAEMON_RESTARTED",
      retryable: false,
    };
    await this.write(unknown);
    return unknown;
  }

  private async read(operationId: string): Promise<ReloadOperation | null> {
    try {
      const operation = AgentReloadOperationSchema.parse(
        JSON.parse(await readFile(this.path(operationId), "utf8")),
      );
      if (operation.operationId !== operationId)
        throw new Error("Reload receipt identity mismatch");
      return operation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(operation: ReloadOperation): Promise<void> {
    await writeJsonFileAtomic(this.path(operation.operationId), operation);
    this.index(operation);
  }

  private path(operationId: string): string {
    return join(this.directory, `${createHash("sha256").update(operationId).digest("hex")}.json`);
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.admission.then(run);
    this.admission = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
