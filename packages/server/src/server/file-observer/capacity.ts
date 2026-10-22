export type FileObservationCapacityRetryReason = "capacity-released" | "recheck";

export interface FileObservationCapacityFailure {
  root: string;
  scope: "shared" | "root";
  requiredEntries: number;
  limit: number;
}

export interface FileObservationCapacityRetry {
  signal: AbortSignal;
  recheckAfterMs: number;
  run(reason: FileObservationCapacityRetryReason): Promise<void>;
}

/** A failed inventory's lower bound, with cancellable recovery admission. */
export class FileObservationCapacityError extends Error {
  readonly root: string;
  readonly scope: "shared" | "root";
  readonly requiredEntries: number;
  readonly limit: number;

  constructor(
    failure: FileObservationCapacityFailure,
    private readonly schedule: (retry: FileObservationCapacityRetry) => Promise<void>,
  ) {
    const limit =
      failure.scope === "shared" ? `shared inventory limit of ${failure.limit}` : failure.limit;
    super(`Recursive file observation exceeded ${limit} entries under ${failure.root}`);
    this.name = "FileObservationCapacityError";
    this.root = failure.root;
    this.scope = failure.scope;
    this.requiredEntries = failure.requiredEntries;
    this.limit = failure.limit;
  }

  retryWhenAvailable(retry: FileObservationCapacityRetry): Promise<void> {
    return this.schedule(retry);
  }
}
