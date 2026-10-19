import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MAIN_HOST_MAX_GENERATION,
  type MainHostApplyInput,
  type MainHostChoice,
  type MainHostProvenance,
  type MainHostSetInput,
  type MainHostState,
} from "@getpaseo/protocol/fleet/main-host";
import { readPersistedConfig } from "../persisted-config.js";
import { MainHostStore, type MainHostRefusal } from "./main-host-store.js";

interface StoreFixture {
  home: string;
  store: MainHostStore;
}

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-main-failure-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function actor(
  serverId: string,
  clientType: MainHostProvenance["clientType"] = "browser",
): MainHostProvenance {
  return {
    principalId: "owner",
    clientId: `tim-${clientType}`,
    sessionId: `${serverId}-${clientType}-session`,
    serverId,
    clientType,
  };
}

async function createStore(serverId: string, directory = serverId): Promise<StoreFixture> {
  const home = path.join(temporaryRoot, directory);
  const store = new MainHostStore({ paseoHome: home, serverId });
  await store.initialize();
  return { home, store };
}

async function restart(fixture: StoreFixture): Promise<StoreFixture> {
  const store = new MainHostStore({
    paseoHome: fixture.home,
    serverId: fixture.store.allocator().serverId,
  });
  await store.initialize();
  return { home: fixture.home, store };
}

function requireChoice(state: MainHostState): MainHostChoice {
  if (!state.choice) throw new Error("The fixture did not allocate a Main host choice");
  return state.choice;
}

async function allocate(
  fixture: StoreFixture,
  mainHost: string | null,
  requestId: string,
  clientType: MainHostProvenance["clientType"] = "browser",
): Promise<MainHostChoice> {
  const state = await fixture.store.set(
    {
      mainHost,
      expectedGeneration: fixture.store.snapshot().choice?.generation ?? 0,
      requestId,
    },
    actor(fixture.store.allocator().serverId, clientType),
  );
  return requireChoice(state);
}

function deliveryInput(
  fixture: StoreFixture,
  choice: MainHostChoice,
  requestId: string,
  overrides: Partial<MainHostApplyInput> = {},
): MainHostApplyInput {
  return {
    choice,
    expectedLocalGeneration: fixture.store.snapshot().choice?.generation ?? 0,
    confirmation: { allocationId: choice.allocationId },
    requestId,
    ...overrides,
  };
}

async function fleetBytes(fixture: StoreFixture): Promise<string | null> {
  try {
    return await readFile(path.join(fixture.home, "fleet.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function expectUnchangedRefusal(
  fixture: StoreFixture,
  attempt: () => Promise<unknown>,
  code: MainHostRefusal["code"],
): Promise<void> {
  const before = fixture.store.snapshot();
  const bytes = await fleetBytes(fixture);
  const current: MainHostState = bytes
    ? (JSON.parse(bytes) as { state: MainHostState }).state
    : { choice: null, held: false, delivery: null };

  await expect(attempt()).rejects.toMatchObject({ name: "MainHostRefusal", code, current });
  expect(fixture.store.snapshot()).toEqual(before);
  expect(await fleetBytes(fixture)).toBe(bytes);
}

async function deliverFrom(
  source: StoreFixture,
  receiver: StoreFixture,
  choice: MainHostChoice,
  requestId: string,
): Promise<MainHostState> {
  return receiver.store.apply(
    deliveryInput(receiver, choice, requestId, {
      allocatorPublicKey: source.store.allocator().publicKey,
    }),
    actor(receiver.store.allocator().serverId),
  );
}

describe("DOTS2-MAIN-CAS#contract · allocation failures and retries", () => {
  test("concurrent requests in one home allocate only once and replay before stale CAS", async () => {
    const first = await createStore("host-a");
    const second = await restart(first);
    const request = { mainHost: "host-a", expectedGeneration: 0, requestId: "same-request" };
    const attempts = await Promise.allSettled([
      first.store.set(request, actor("host-a")),
      second.store.set(request, actor("host-a")),
    ]);
    const successes = attempts.filter((result) => result.status === "fulfilled");
    const refusals = attempts.filter((result) => result.status === "rejected");

    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(refusals.map((result) => result.reason.code)).toEqual(
      Array(refusals.length).fill("fleet_busy"),
    );
    const firstReplay = await first.store.set(request, actor("host-a"));
    const secondReplay = await second.store.set(request, actor("host-a"));
    expect(firstReplay).toEqual(secondReplay);
    expect(firstReplay.choice?.generation).toBe(1);
    expect(JSON.parse((await fleetBytes(first))!).allocations).toHaveLength(1);
  });

  test("different concurrent same-home choices have one winner and a stale retry keeps it", async () => {
    const first = await createStore("host-a");
    const second = await restart(first);
    const attempts = await Promise.allSettled([
      first.store.set(
        { mainHost: "host-a", expectedGeneration: 0, requestId: "choose-a" },
        actor("host-a"),
      ),
      second.store.set(
        { mainHost: "host-b", expectedGeneration: 0, requestId: "choose-b" },
        actor("host-a"),
      ),
    ]);
    const successes = attempts.filter((result) => result.status === "fulfilled");
    const refusals = attempts.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(["fleet_busy", "stale_generation"]).toContain(refusals[0].reason.code);
    const winner = requireChoice(successes[0].value);
    const durable = await restart(first);
    expect(durable.store.snapshot().choice).toEqual(winner);

    await expectUnchangedRefusal(
      durable,
      () =>
        durable.store.set(
          { mainHost: "host-c", expectedGeneration: 0, requestId: "stale-retry" },
          actor("host-a"),
        ),
      "stale_generation",
    );
    const next = await allocate(durable, "host-c", "explicit-retry");
    expect(next.generation).toBe(2);
    expect(next.previousMainHost).toBe(winner.mainHost);
  });

  test("two isolated daemons' generation-one choices conflict without changing either", async () => {
    const first = await createStore("host-a");
    const second = await createStore("host-b");
    const [choiceA, choiceB] = await Promise.all([
      allocate(first, "host-a", "first-a"),
      allocate(second, "host-b", "first-b"),
    ]);
    expect([choiceA.generation, choiceB.generation]).toEqual([1, 1]);
    expect(choiceA.allocationId).not.toBe(choiceB.allocationId);
    await expectUnchangedRefusal(
      second,
      () => deliverFrom(first, second, choiceA, "conflicting-a"),
      "allocation_conflict",
    );
    await expectUnchangedRefusal(
      first,
      () => deliverFrom(second, first, choiceB, "conflicting-b"),
      "allocation_conflict",
    );
  });

  test("replays durable set and delivery receipts after restart without restoring held state", async () => {
    const fixture = await createStore("host-a");
    const held = await fixture.store.set(
      { mainHost: "host-a", expectedGeneration: 0, requestId: "lost-set-reply" },
      actor("host-a"),
    );
    const choice = requireChoice(held);
    const request = deliveryInput(fixture, choice, "lost-delivery-reply");
    const delivered = await fixture.store.apply(request, actor("host-a"));
    const reloaded = await restart(fixture);
    const bytes = await fleetBytes(reloaded);

    expect(
      await reloaded.store.set(
        { mainHost: "host-a", expectedGeneration: 0, requestId: "lost-set-reply" },
        actor("host-a"),
      ),
    ).toEqual(held);
    expect(await reloaded.store.apply(request, actor("host-a"))).toEqual(delivered);
    expect(reloaded.store.snapshot()).toEqual(delivered);
    expect(await fleetBytes(reloaded)).toBe(bytes);
  });

  test.each([
    ["generation", { generation: 5 }],
    ["setAt", { setAt: "2000-01-01T00:00:00.000Z" }],
    ["setBy", { setBy: actor("forged-host") }],
    ["actor", { actor: "Tim" }],
  ])("rejects caller-supplied %s without writing", async (_field, supplied) => {
    const fixture = await createStore("host-a");
    await allocate(fixture, "host-a", "prior-choice");
    const before = fixture.store.snapshot();
    const bytes = await fleetBytes(fixture);
    const request = {
      mainHost: "host-b",
      expectedGeneration: 1,
      requestId: "invalid-caller-input",
      ...supplied,
    };

    await expect(fixture.store.set(request, actor("host-a"))).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(fixture.store.snapshot()).toEqual(before);
    expect(await fleetBytes(fixture)).toBe(bytes);
  });

  test("generation exhaustion refuses before any new allocation or receipt is written", async () => {
    const fixture = await createStore("host-a");
    const choice = await allocate(fixture, "host-a", "before-cap");
    const file = JSON.parse((await fleetBytes(fixture))!) as { state: MainHostState };
    file.state.choice = { ...choice, generation: MAIN_HOST_MAX_GENERATION };
    await writeFile(path.join(fixture.home, "fleet.json"), JSON.stringify(file));
    const atCap = await restart(fixture);

    await expectUnchangedRefusal(
      atCap,
      () =>
        atCap.store.set(
          {
            mainHost: "host-b",
            expectedGeneration: MAIN_HOST_MAX_GENERATION,
            requestId: "after-cap",
          },
          actor("host-a"),
        ),
      "generation_exhausted",
    );
  });

  test.each([-1, MAIN_HOST_MAX_GENERATION + 1, 1.5])(
    "rejects out-of-range expected generation %s without changing the prior choice",
    async (expectedGeneration) => {
      const fixture = await createStore("host-a");
      await allocate(fixture, "host-a", "valid-choice");
      const before = fixture.store.snapshot();
      const bytes = await fleetBytes(fixture);
      const request: MainHostSetInput = {
        mainHost: "host-b",
        expectedGeneration,
        requestId: "out-of-range",
      };

      await expect(fixture.store.set(request, actor("host-a"))).rejects.toMatchObject({
        name: "ZodError",
      });
      expect(fixture.store.snapshot()).toEqual(before);
      expect(await fleetBytes(fixture)).toBe(bytes);
    },
  );
});

describe("DOTS2-MAIN-CAS#contract · verified delivery and refusal", () => {
  test("a pinned receiver can jump to generation four and rejects stale delivery and CAS", async () => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const first = await allocate(source, "host-a", "generation-one");
    await deliverFrom(source, receiver, first, "pin-and-deliver-one");
    await allocate(source, "host-b", "generation-two");
    await allocate(source, "host-a", "generation-three");
    const fourth = await allocate(source, "host-b", "generation-four");
    const delivered = await deliverFrom(source, receiver, fourth, "jump-to-four");
    expect(delivered.choice).toEqual(fourth);
    expect(delivered.held).toBe(false);
    expect(delivered.delivery?.allocationId).toBe(fourth.allocationId);

    await expectUnchangedRefusal(
      receiver,
      () => deliverFrom(source, receiver, first, "stale-one"),
      "allocation_conflict",
    );
    await expectUnchangedRefusal(
      receiver,
      () =>
        receiver.store.apply(
          deliveryInput(receiver, fourth, "stale-local-cas", { expectedLocalGeneration: 1 }),
          actor("host-b"),
        ),
      "stale_generation",
    );
  });

  test("an exact allocation delivery is a state no-op and does not duplicate allocation history", async () => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const choice = await allocate(source, "host-a", "first-choice");
    const delivered = await deliverFrom(source, receiver, choice, "first-delivery");
    const repeated = await receiver.store.apply(
      deliveryInput(receiver, choice, "same-allocation-again", { confirmation: null }),
      actor("host-b"),
    );

    expect(repeated).toEqual(delivered);
    expect(receiver.store.snapshot()).toEqual(delivered);
    expect(JSON.parse((await fleetBytes(receiver))!).allocations).toHaveLength(1);
  });

  test.each([
    ["host", (choice: MainHostChoice) => ({ ...choice, mainHost: "forged-host" })],
    ["generation", (choice: MainHostChoice) => ({ ...choice, generation: choice.generation + 1 })],
    ["time", (choice: MainHostChoice) => ({ ...choice, setAt: "2000-01-01T00:00:00.000Z" })],
    [
      "actor",
      (choice: MainHostChoice) => ({
        ...choice,
        setBy: { ...choice.setBy, clientId: "forged-client" },
      }),
    ],
    [
      "receipt",
      (choice: MainHostChoice) => ({ ...choice, receipt: Buffer.alloc(64).toString("base64") }),
    ],
  ])(
    "rejects an altered %s without installing its key or changing prior state",
    async (_field, alter) => {
      const source = await createStore("host-a");
      const receiver = await createStore("host-b");
      const choice = await allocate(source, "host-a", "signed-choice");

      await expectUnchangedRefusal(
        receiver,
        () => deliverFrom(source, receiver, alter(choice), "forged-delivery"),
        "invalid_receipt",
      );
    },
  );

  test("rejects a generation above the wire cap before changing the receiver", async () => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const choice = await allocate(source, "host-a", "valid-source");
    const bytes = await fleetBytes(receiver);
    const before = receiver.store.snapshot();

    await expect(
      deliverFrom(
        source,
        receiver,
        { ...choice, generation: MAIN_HOST_MAX_GENERATION + 1 },
        "out-of-range-delivery",
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(receiver.store.snapshot()).toEqual(before);
    expect(await fleetBytes(receiver)).toBe(bytes);
  });

  test("a key from a different allocator cannot verify the signed choice", async () => {
    const source = await createStore("host-a");
    const other = await createStore("host-c");
    const receiver = await createStore("host-b");
    const choice = await allocate(source, "host-a", "signed-choice");

    await expectUnchangedRefusal(
      receiver,
      () =>
        receiver.store.apply(
          deliveryInput(receiver, choice, "wrong-key", {
            allocatorPublicKey: other.store.allocator().publicKey,
          }),
          actor("host-b"),
        ),
      "invalid_receipt",
    );
  });

  test.each(["browser", "cli", "mcp", "hub", "unknown"] as const)(
    "a %s delivery without an existing pin or authenticated app-supplied key is refused",
    async (clientType) => {
      const source = await createStore("host-a");
      const receiver = await createStore("host-b");
      const choice = await allocate(source, "host-a", "unverified-choice");

      await expectUnchangedRefusal(
        receiver,
        () =>
          receiver.store.apply(
            deliveryInput(receiver, choice, "missing-pin", { confirmation: null }),
            actor("host-b", clientType),
          ),
        "allocator_unverified",
      );
    },
  );

  test.each([
    ...(["cli", "mcp", "hub", "unknown"] as const).map((type) => ({
      name: type,
      provenance: actor("host-b", type),
    })),
    { name: "non-owner app", provenance: { ...actor("host-b"), principalId: "other" } },
  ])("$name cannot establish a new allocator pin by supplying a key", async ({ provenance }) => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const choice = await allocate(source, "host-a", "signed-choice");

    await expectUnchangedRefusal(
      receiver,
      () =>
        receiver.store.apply(
          deliveryInput(receiver, choice, "cli-pin", {
            confirmation: null,
            allocatorPublicKey: source.store.allocator().publicKey,
          }),
          provenance,
        ),
      "allocator_unverified",
    );
  });

  test("a changed pinned allocator key is refused even for an owner app after restart", async () => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const replacement = await createStore("host-a", "replacement-allocator");
    const choice = await allocate(source, "host-a", "original-key-choice");
    await deliverFrom(source, receiver, choice, "pin-original-key");
    const reloaded = await restart(receiver);

    await expectUnchangedRefusal(
      reloaded,
      () =>
        reloaded.store.apply(
          deliveryInput(reloaded, choice, "changed-key", {
            allocatorPublicKey: replacement.store.allocator().publicKey,
          }),
          actor("host-b"),
        ),
      "allocator_unverified",
    );
  });

  test.each([
    ...(["cli", "mcp", "hub", "unknown"] as const).map((type) => ({
      name: type,
      provenance: actor("host-b", type),
    })),
    { name: "non-owner app", provenance: { ...actor("host-b"), principalId: "other" } },
  ])(
    "$name cannot supply an already-pinned key or confirm a held allocation",
    async ({ provenance }) => {
      const source = await createStore("host-a");
      const receiver = await createStore("host-b");
      const first = await allocate(source, "host-a", "first-choice");
      await deliverFrom(source, receiver, first, "app-pins-key");
      const next = await allocate(source, "host-b", "cli-choice", "cli");

      await expectUnchangedRefusal(
        receiver,
        () =>
          receiver.store.apply(
            deliveryInput(receiver, next, "cli-supplies-pinned-key", {
              confirmation: null,
              allocatorPublicKey: source.store.allocator().publicKey,
            }),
            provenance,
          ),
        "allocator_unverified",
      );
      await expectUnchangedRefusal(
        receiver,
        () => receiver.store.apply(deliveryInput(receiver, next, "cli-confirms"), provenance),
        "confirmation_required",
      );
    },
  );

  test("CLI delivery with an existing pin remains held across restart until Tim confirms", async () => {
    const source = await createStore("host-a");
    const receiver = await createStore("host-b");
    const first = await allocate(source, "host-a", "first-choice");
    await deliverFrom(source, receiver, first, "app-pins-key");
    const next = await allocate(source, "host-b", "cli-choice", "cli");
    const held = await receiver.store.apply(
      deliveryInput(receiver, next, "cli-held-delivery", { confirmation: null }),
      actor("host-b", "cli"),
    );
    expect(held).toEqual({ choice: next, held: true, delivery: null });
    const reloaded = await restart(receiver);
    expect(reloaded.store.snapshot()).toEqual(held);
    const delivered = await reloaded.store.apply(
      deliveryInput(reloaded, next, "tim-delivers"),
      actor("host-b"),
    );
    expect(delivered.choice).toEqual(next);
    expect(delivered.held).toBe(false);
    expect(delivered.delivery?.confirmedBy).toEqual(actor("host-b"));
    expect((await restart(reloaded)).store.snapshot()).toEqual(delivered);
  });
});

describe("DOTS2-114 · durable held, undo and interrupted-write recovery", () => {
  test("held, Deliver and Undo retain their original allocations and provenance across restarts", async () => {
    const initial = await createStore("host-a");
    const first = await allocate(initial, "host-a", "initial-main");
    await initial.store.apply(deliveryInput(initial, first, "confirm-initial"), actor("host-a"));
    const heldChoice = await allocate(initial, "host-b", "agent-change", "cli");
    const held = initial.store.snapshot();
    const awaitingTim = await restart(initial);
    expect(awaitingTim.store.snapshot()).toEqual(held);
    expect(held).toEqual({ choice: heldChoice, held: true, delivery: null });
    const delivered = await awaitingTim.store.apply(
      deliveryInput(awaitingTim, heldChoice, "deliver-agent-change"),
      actor("host-a"),
    );
    const afterDelivery = await restart(awaitingTim);
    expect(afterDelivery.store.snapshot()).toEqual(delivered);
    expect(delivered.choice?.setBy).toEqual(actor("host-a", "cli"));
    expect(delivered.delivery?.confirmedBy).toEqual(actor("host-a"));

    const undo = await allocate(afterDelivery, heldChoice.previousMainHost, "undo-agent-change");
    expect(undo.generation).toBe(3);
    expect(undo.mainHost).toBe("host-a");
    expect(undo.undoOf).toBe(heldChoice.allocationId);
    expect(undo.previousMainHost).toBe("host-b");
    const confirmedUndo = await afterDelivery.store.apply(
      deliveryInput(afterDelivery, undo, "confirm-undo"),
      actor("host-a"),
    );
    const final = await restart(afterDelivery);
    expect(final.store.snapshot()).toEqual(confirmedUndo);
    const file = JSON.parse((await fleetBytes(final))!) as { allocations: MainHostChoice[] };
    expect(file.allocations).toEqual([first, heldChoice, undo]);
  });

  test("keeps strict legacy config readable and byte-identical across allocation and restart", async () => {
    const fixture = await createStore("host-a");
    const config =
      '{\n  "daemon": { "listen": "127.0.0.1:9876", "autoArchiveAfterMerge": false }\n}\n';
    const configPath = path.join(fixture.home, "config.json");
    await writeFile(configPath, config);
    const before = readPersistedConfig(fixture.home);
    const choice = await allocate(fixture, "host-a", "main-with-legacy-config");
    await fixture.store.apply(deliveryInput(fixture, choice, "deliver-main"), actor("host-a"));
    await restart(fixture);

    expect(readPersistedConfig(fixture.home)).toEqual(before);
    expect(readPersistedConfig(fixture.home).daemon?.listen).toBe("127.0.0.1:9876");
    expect(await readFile(configPath, "utf8")).toBe(config);
  });

  test("reads the complete old or new choice around an interrupted temporary write and rename", async () => {
    const fixture = await createStore("host-a");
    await allocate(fixture, "host-a", "old-complete-choice");
    const oldState = fixture.store.snapshot();
    const oldBytes = (await fleetBytes(fixture))!;
    await allocate(fixture, "host-b", "new-complete-choice");
    const newState = fixture.store.snapshot();
    const newBytes = (await fleetBytes(fixture))!;
    const filePath = path.join(fixture.home, "fleet.json");
    const temporaryPath = `${filePath}.interrupted.tmp`;

    await writeFile(filePath, oldBytes);
    await writeFile(temporaryPath, '{"version":1,"state":');
    expect((await restart(fixture)).store.snapshot()).toEqual(oldState);
    expect(await readFile(filePath, "utf8")).toBe(oldBytes);

    await writeFile(temporaryPath, newBytes);
    await rename(temporaryPath, filePath);
    expect((await restart(fixture)).store.snapshot()).toEqual(newState);
    expect(await readFile(filePath, "utf8")).toBe(newBytes);
  });

  test("the injected database guard refuses allocation and delivery without changing the prior setting", async () => {
    const fixture = await createStore("host-a");
    const choice = await allocate(fixture, "host-a", "before-database-guard");
    const guarded: StoreFixture = {
      home: fixture.home,
      store: new MainHostStore({
        paseoHome: fixture.home,
        serverId: "host-a",
        hasDotsDatabase: () => true,
      }),
    };
    await guarded.store.initialize();
    await expectUnchangedRefusal(
      guarded,
      () =>
        guarded.store.set(
          { mainHost: "host-b", expectedGeneration: 1, requestId: "move-set" },
          actor("host-a"),
        ),
      "move_required",
    );
    await expectUnchangedRefusal(
      guarded,
      () => guarded.store.apply(deliveryInput(guarded, choice, "move-delivery"), actor("host-a")),
      "move_required",
    );
  });

  test("recovers a lock owned by an exited process without changing its durable choice", async () => {
    const fixture = await createStore("host-a");
    await allocate(fixture, "host-a", "before-process-exit");
    const before = fixture.store.snapshot();
    const bytes = await fleetBytes(fixture);
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(exited.status).toBe(0);
    const lockPath = path.join(fixture.home, "fleet.json.lock");
    await writeFile(lockPath, String(exited.pid));

    const reloaded = await restart(fixture);
    expect(reloaded.store.snapshot()).toEqual(before);
    expect(await fleetBytes(reloaded)).toBe(bytes);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    { name: "the current worker's PID", pid: process.pid, beforeBoot: false },
    { name: "a PID reused by another live process", pid: process.ppid, beforeBoot: false },
    { name: "an inaccessible PID (EPERM)", pid: 1, beforeBoot: false },
    { name: "a lock from before this boot", pid: process.pid, beforeBoot: true },
  ])("boot recovers $name without changing the durable choice", async ({ pid, beforeBoot }) => {
    const fixture = await createStore("host-a");
    await allocate(fixture, "host-a", "before-worker-restart");
    const before = fixture.store.snapshot();
    const bytes = await fleetBytes(fixture);
    const publicKey = fixture.store.allocator().publicKey;
    const lockPath = path.join(fixture.home, "fleet.json.lock");
    await writeFile(lockPath, String(pid));
    if (beforeBoot) await utimes(lockPath, new Date(0), new Date(0));

    const probe =
      pid === 1
        ? vi.spyOn(process, "kill").mockImplementation(() => {
            throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
          })
        : undefined;
    let reloaded: StoreFixture;
    try {
      reloaded = await restart(fixture);
      if (probe) expect(probe).not.toHaveBeenCalled();
    } finally {
      probe?.mockRestore();
    }
    expect(reloaded.store.snapshot()).toEqual(before);
    expect(reloaded.store.allocator().publicKey).toBe(publicKey);
    expect(await fleetBytes(reloaded)).toBe(bytes);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await allocate(reloaded, "host-b", "after-worker-restart")).generation).toBe(2);
  });
});
