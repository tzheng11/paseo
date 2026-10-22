import { getHeapStatistics } from "node:v8";

export const DEFAULT_NATIVE_MAX_TRACKED_ENTRIES = 1_000_000;

const MAX_NATIVE_TRACKED_ENTRIES = 2_000_000;
const LARGE_INVENTORY_MIN_HEAP_BYTES = 16 * 1024 ** 3;
const LIMIT_ENV = "PASEO_NATIVE_MAX_TRACKED_ENTRIES";

/** Keep larger inventories an explicit choice on hosts with enough V8 heap headroom. */
export function resolveNativeInventoryLimit(
  env: NodeJS.ProcessEnv,
  getHeapLimit: () => number = () => getHeapStatistics().heap_size_limit,
): number {
  const configured = env[LIMIT_ENV];
  if (configured === undefined) {
    return DEFAULT_NATIVE_MAX_TRACKED_ENTRIES;
  }

  const limit = Number(configured);
  if (
    !/^[1-9]\d*$/.test(configured) ||
    !Number.isSafeInteger(limit) ||
    limit > MAX_NATIVE_TRACKED_ENTRIES
  ) {
    throw new Error(`${LIMIT_ENV} must be an integer between 1 and ${MAX_NATIVE_TRACKED_ENTRIES}`);
  }

  if (limit > DEFAULT_NATIVE_MAX_TRACKED_ENTRIES) {
    const heapLimit = getHeapLimit();
    if (!Number.isFinite(heapLimit) || heapLimit < LARGE_INVENTORY_MIN_HEAP_BYTES) {
      throw new Error(
        `${LIMIT_ENV} above ${DEFAULT_NATIVE_MAX_TRACKED_ENTRIES} requires at least 16 GiB of V8 heap`,
      );
    }
  }

  return limit;
}
