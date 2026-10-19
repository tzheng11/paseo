import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { MainHostStore } from "./main-host-store.js";
import type { MainHostProvenance } from "@getpaseo/protocol/fleet/main-host";

const owner: MainHostProvenance = {
  principalId: "owner",
  clientId: "browser",
  sessionId: "session",
  serverId: "host-a",
  clientType: "browser",
};

test("Main allocations and app delivery survive restart with private allocator keys", async () => {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-main-"));
  try {
    const store = new MainHostStore({ paseoHome, serverId: "host-a" });
    await store.initialize();
    expect(store.snapshot()).toEqual({ choice: null, held: false, delivery: null });
    const allocated = await store.set(
      { mainHost: "host-b", expectedGeneration: 0, requestId: "first" },
      owner,
    );
    expect(allocated.choice?.generation).toBe(1);
    expect(allocated.held).toBe(true);
    if (!allocated.choice) throw new Error("Expected an allocation");
    const delivered = await store.apply(
      {
        choice: allocated.choice,
        expectedLocalGeneration: 1,
        confirmation: { allocationId: allocated.choice.allocationId },
        requestId: "deliver",
      },
      owner,
    );
    expect(delivered.held).toBe(false);
    const restarted = new MainHostStore({ paseoHome, serverId: "host-a" });
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(delivered);
    expect(
      await restarted.set({ mainHost: "host-b", expectedGeneration: 0, requestId: "first" }, owner),
    ).toEqual(allocated);
    if (process.platform !== "win32")
      expect((await stat(path.join(paseoHome, "fleet-allocator-key.pem"))).mode & 0o777).toBe(
        0o600,
      );
  } finally {
    await rm(paseoHome, { recursive: true, force: true });
  }
});
