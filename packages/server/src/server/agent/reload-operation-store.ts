import { createHash } from "node:crypto";
import type { CredentialChange } from "./quota-turn-recovery.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AgentReloadOperationSchema, type AgentReloadOperation } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

export type ReloadOperation = AgentReloadOperation;

/** Durable receipts outlive sockets. A pending receipt from another process is never replayed. */
export class ReloadOperationStore {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  start(
    agentId: string,
    operationId: string,
    run: () => Promise<ReloadOperation["continuation"] | void>,
    change?: CredentialChange,
  ): Promise<ReloadOperation> {
    return this.serialize(async () => {
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
      const operation = await this.read(operationId);
      return operation ? this.reconcile(operation) : null;
    });
  }

  private async complete(
    operation: ReloadOperation,
    run: () => Promise<ReloadOperation["continuation"] | void>,
  ): Promise<void> {
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

  private write(operation: ReloadOperation): Promise<void> {
    return writeJsonFileAtomic(this.path(operation.operationId), operation);
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
