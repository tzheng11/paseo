import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { serializeWorkspaceBacking } from "./workspace-retirement-context.js";

const homes: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "backing-scopes-"));
  homes.push(home);
  const a = path.join(home, "a"),
    b = path.join(home, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  return { home, a, b };
}
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test("an unrelated path proceeds past a paused lease and its conflicting waiter", async () => {
  const f = await fixture();
  const ready = deferred(),
    release = deferred();
  const order: string[] = [];
  const first = serializeWorkspaceBacking(f.a, async () => {
    order.push("a-start");
    ready.resolve();
    await release.promise;
  });
  await ready.promise;
  const waiting = serializeWorkspaceBacking(f.a, async () => {
    order.push("a-next");
  });
  try {
    await serializeWorkspaceBacking(f.b, async () => {
      order.push("b");
    });
    expect(order).toEqual(["a-start", "b"]);
  } finally {
    release.resolve();
    await Promise.all([first, waiting]);
  }
  expect(order).toEqual(["a-start", "b", "a-next"]);
});

test("nested and symlink paths remain excluded until the backing lease closes", async () => {
  const f = await fixture();
  const alias = path.join(f.home, "alias");
  await symlink(f.a, alias);
  const ready = deferred(),
    release = deferred();
  const order: string[] = [];
  const first = serializeWorkspaceBacking(f.a, async () => {
    ready.resolve();
    await release.promise;
    order.push("closed");
  });
  await ready.promise;
  const child = serializeWorkspaceBacking(path.join(alias, "not-created", "child"), async () => {
    order.push("child");
  });
  try {
    await serializeWorkspaceBacking(f.b, async () => {});
    expect(order).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([first, child]);
  }
  expect(order).toEqual(["closed", "child"]);
});

test("covered reentrancy succeeds even when another caller is waiting for that backing", async () => {
  const f = await fixture();
  const ready = deferred(),
    proceed = deferred();
  const order: string[] = [];
  const first = serializeWorkspaceBacking(f.a, async () => {
    ready.resolve();
    await proceed.promise;
    await serializeWorkspaceBacking(f.a, async () => {
      order.push("nested");
    });
  });
  await ready.promise;
  const next = serializeWorkspaceBacking(f.a, async () => {
    order.push("next");
  });
  proceed.resolve();
  await Promise.all([first, next]);
  expect(order).toEqual(["nested", "next"]);
});

test("complete opposite multi-path scopes serialize without a lock-order deadlock", async () => {
  const f = await fixture();
  const ready = deferred(),
    release = deferred();
  const order: string[] = [];
  const first = serializeWorkspaceBacking({ paths: [f.a, f.b] }, async () => {
    ready.resolve();
    await release.promise;
    order.push("first");
  });
  await ready.promise;
  const second = serializeWorkspaceBacking({ paths: [f.b, f.a] }, async () => {
    order.push("second");
  });
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
});

test("a conflicting nested expansion refuses instead of retaining one lease while waiting for another", async () => {
  const f = await fixture();
  const aReady = deferred(),
    bReady = deferred();
  const a = serializeWorkspaceBacking(f.a, async () => {
    aReady.resolve();
    await bReady.promise;
    return serializeWorkspaceBacking(f.b, async () => {});
  });
  const b = serializeWorkspaceBacking(f.b, async () => {
    bReady.resolve();
    await aReady.promise;
    return serializeWorkspaceBacking(f.a, async () => {});
  });
  const outcomes = await Promise.allSettled([a, b]);
  expect(
    outcomes.some(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason.message === "workspace_backing_scope_conflict",
    ),
  ).toBe(true);
  await serializeWorkspaceBacking({ paths: [f.a, f.b] }, async () => {});
});

test("an explicit project read set excludes membership changes without blocking another project", async () => {
  const f = await fixture();
  const ready = deferred(),
    release = deferred();
  const order: string[] = [];
  const first = serializeWorkspaceBacking({ paths: [f.a], keys: ["project-a"] }, async () => {
    ready.resolve();
    await release.promise;
    order.push("removed-a");
  });
  await ready.promise;
  const membership = serializeWorkspaceBacking({ paths: [f.b], keys: ["project-a"] }, async () => {
    order.push("member-a");
  });
  try {
    await serializeWorkspaceBacking(
      { paths: [path.join(f.home, "c")], keys: ["project-c"] },
      async () => {
        order.push("c");
      },
    );
    expect(order).toEqual(["c"]);
  } finally {
    release.resolve();
    await Promise.all([first, membership]);
  }
  expect(order).toEqual(["c", "removed-a", "member-a"]);
});

test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "case aliases of a future path share a lease",
  async () => {
    const f = await fixture();
    const ready = deferred(),
      release = deferred();
    const order: string[] = [];
    const first = serializeWorkspaceBacking(path.join(f.a, "Future"), async () => {
      ready.resolve();
      await release.promise;
      order.push("closed");
    });
    await ready.promise;
    const alias = serializeWorkspaceBacking(path.join(f.a, "future"), async () => {
      order.push("alias");
    });
    try {
      await serializeWorkspaceBacking(f.b, async () => {});
      expect(order).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all([first, alias]);
    }
    expect(order).toEqual(["closed", "alias"]);
  },
);

test("RECLAIM provider admission refuses a busy backing instead of waiting with an agent lifecycle lane", async () => {
  const f = await fixture(),
    started = deferred(),
    release = deferred();
  const retirement = serializeWorkspaceBacking(f.a, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  try {
    await expect(
      serializeWorkspaceBacking({ paths: [f.a], rejectIfBusy: true }, async () => {}),
    ).rejects.toThrow("workspace_backing_busy");
    await serializeWorkspaceBacking({ paths: [f.b], rejectIfBusy: true }, async () => {});
  } finally {
    release.resolve();
    await retirement;
  }
});
