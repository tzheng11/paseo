import { AsyncLocalStorage } from "node:async_hooks";

let backingQueue: Promise<unknown> = Promise.resolve();
const backingOwner = new AsyncLocalStorage<{ active: boolean }>();

/** Native backing transitions share one process queue; nested registration keeps the same lease. */
export async function serializeWorkspaceBacking<T>(
  _backing: string,
  run: () => Promise<T>,
): Promise<T> {
  if (backingOwner.getStore()?.active) return run();
  const lease = { active: true };
  const next = backingQueue
    .catch(() => {})
    .then(() =>
      backingOwner.run(lease, async () => {
        try {
          return await run();
        } finally {
          lease.active = false;
        }
      }),
    );
  backingQueue = next;
  return next;
}
