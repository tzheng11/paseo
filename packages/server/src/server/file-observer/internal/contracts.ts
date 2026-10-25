import type {
  FileChangeType,
  FileObserverDiagnostics,
  FileObserverInventoryAdmission,
} from "../index.js";

export interface ObserverMetrics extends Omit<
  FileObserverDiagnostics,
  | "activeObservationCount"
  | "nativeHandleCount"
  | "nativeTrackedFileCount"
  | "nativeAuditQueuedCount"
  | "nativeAuditAdmittedCount"
  | "pendingEventCount"
  | "pendingReconciliationWorkCount"
  | "pendingClassificationCount"
  | "reconciliationInFlightCount"
> {}

export interface BackendDiagnostics {
  nativeHandleCount: number;
  nativeTrackedFileCount: number;
  nativeAuditQueuedCount?: number;
  nativeAuditAdmittedCount?: number;
  pendingReconciliationWorkCount: number;
  pendingClassificationCount: number;
  reconciliationInFlight: boolean;
}

export interface ObservationBackend {
  start(): Promise<void>;
  updateIgnore(): Promise<void>;
  close(): Promise<void>;
  getDiagnostics(): BackendDiagnostics;
}

export interface ObservationHost {
  root: string;
  metrics: ObserverMetrics;
  readonly ignoredRoots?: readonly string[];
  isActive(): boolean;
  isIgnored(path: string): boolean;
  isPathInside(root: string, path: string): boolean;
  onInventoryProgress?(): void;
  onInventoryAdmission?(state: FileObserverInventoryAdmission): void;
  queueEvent(type: FileChangeType, path: string): void;
  fail(error: Error): void;
}

export type CreateObservationBackend = (host: ObservationHost) => ObservationBackend;
