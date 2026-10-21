import { describe, expect, it, vi } from "vitest";

// UUID generation is a platform boundary; policy tests do not need Expo's native/AES runtime.
vi.mock("expo-crypto", async () => {
  const { randomUUID, webcrypto } = await import("node:crypto");
  return { randomUUID, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
});

import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { MainHostChoice, MainHostProvenance } from "@getpaseo/protocol/fleet/main-host";
import {
  isMainHostReadPending,
  resolveMainHost,
  shouldClearMainHostError,
  verifyMainHostUndo,
  type MainHostView,
} from "./use-main-host";
import { resolveHostIndexRoute, resolveStartupRoute } from "@/navigation/host-runtime-bootstrap";

const provenance: MainHostProvenance = {
  principalId: "owner",
  clientId: "tim-browser",
  sessionId: "browser-session",
  serverId: "studio",
  clientType: "browser",
};

function makeChoice(overrides: Partial<MainHostChoice> = {}): MainHostChoice {
  return {
    allocationId: "00000000-0000-4000-8000-000000000001",
    allocatorServerId: "studio",
    requestId: "first-main-choice",
    mainHost: "studio",
    generation: 1,
    previousMainHost: null,
    undoOf: null,
    setAt: "2026-10-18T11:00:00.000Z",
    setBy: provenance,
    receipt: "allocator-signed-receipt",
    ...overrides,
  };
}

function makeView(
  serverId: string,
  input: Partial<MainHostView> & { choice?: MainHostChoice; held?: boolean } = {},
): MainHostView {
  const { choice = null, held = false, ...overrides } = input;
  return {
    serverId,
    label: serverId,
    connected: true,
    checking: false,
    supported: true,
    canManage: true,
    read: {
      requestId: `read-${serverId}`,
      allocator: { serverId, publicKey: `allocator-public-key-${serverId}` },
      state: {
        choice,
        held,
        delivery:
          choice && !held
            ? {
                allocationId: choice.allocationId,
                confirmedAt: "2026-10-18T11:00:01.000Z",
                confirmedBy: provenance,
              }
            : null,
      },
    },
    error: null,
    ...overrides,
  };
}

describe("Main reads during startup", () => {
  function startupRoute(views: MainHostView[]) {
    return resolveStartupRoute({
      route: { kind: "index", pathname: "/" },
      startupBlocker: { kind: "none" },
      hostRegistryStatus: "ready",
      hosts: views,
      anyOnlineHostServerId: views.find((view) => view.connected)?.serverId ?? null,
      workspaceSelection: null,
      workspaceSelectionStatus: "unknown",
      isWorkspaceSelectionLoaded: true,
      hasGivenUpWaitingForHost: true,
      mainHostServerId: resolveMainHost(views).mainHost,
      mainHostLoading: isMainHostReadPending(views),
    });
  }

  it.each([
    { connected: false, checking: true },
    { connected: false, checking: false },
    { connected: true, supported: false },
  ])("keeps saved-host navigation available for %j", (status) => {
    expect(startupRoute([makeView("studio", { ...status, read: undefined })])).toEqual({
      kind: "redirect",
      href: "/h/studio",
    });
    expect(
      resolveHostIndexRoute({
        serverId: "studio",
        workspaceSelection: null,
        workspaceSelectionStatus: "unknown",
      }),
    ).toBe("/open-project");
  });

  it("waits for a connected compatible Main read, then releases a failed read", () => {
    expect(startupRoute([makeView("studio", { read: undefined })])).toEqual({ kind: "splash" });
    expect(
      startupRoute([
        makeView("studio", { read: undefined, error: new Error("Main read unavailable") }),
      ]),
    ).toEqual({ kind: "redirect", href: "/h/studio" });
  });
});

describe("resolveMainHost", () => {
  it("keeps the default unset when no host has allocated a choice", () => {
    expect(resolveMainHost([makeView("studio"), makeView("laptop")])).toEqual({
      kind: "unset",
      mainHost: null,
    });
    expect(resolveMainHost([])).toEqual({ kind: "unset", mainHost: null });
  });

  it("uses connected views while an unreachable saved host retries its connection", () => {
    const choice = makeChoice();

    expect(
      resolveMainHost([
        makeView("studio", { choice }),
        makeView("laptop", { connected: false, checking: true, read: undefined }),
      ]),
    ).toEqual({ kind: "ready", mainHost: "studio", choice });
  });

  it("never presents unknown or entirely offline settings as unset", () => {
    expect(
      resolveMainHost([makeView("studio", { connected: false, checking: true, read: undefined })]),
    ).toEqual({ kind: "loading", mainHost: null });
    expect(resolveMainHost([makeView("studio", { connected: false })])).toEqual({
      kind: "unavailable",
      mainHost: null,
    });
  });

  it("waits for every connected compatible host's first settings read", () => {
    expect(
      resolveMainHost([
        makeView("studio", { choice: makeChoice() }),
        makeView("laptop", { read: undefined }),
      ]),
    ).toEqual({ kind: "loading", mainHost: null });
  });

  it("keeps a failed host read unavailable instead of showing an agreed default", () => {
    expect(
      resolveMainHost([
        makeView("studio", { choice: makeChoice() }),
        makeView("laptop", { read: undefined, error: new Error("Settings read timed out") }),
      ]),
    ).toEqual({ kind: "unavailable", mainHost: null });
  });

  it.each([false, true])(
    "uses a confirmed consistent choice without depending on catalogue order (reversed: %s)",
    (reversed) => {
      const choice = makeChoice();
      const views = [makeView("studio", { choice }), makeView("laptop", { choice })];
      const ordered = reversed ? views.toReversed() : views;
      const catalogueOrder = ordered.map((view) => view.serverId);

      expect(resolveMainHost(ordered)).toEqual({ kind: "ready", mainHost: "studio", choice });
      expect(ordered.map((view) => view.serverId)).toEqual(catalogueOrder);
    },
  );

  it("ignores disconnected and unsupported hosts' cached choices", () => {
    const choice = makeChoice();
    const other = makeChoice({
      allocationId: "00000000-0000-4000-8000-000000000002",
      mainHost: "laptop",
    });

    expect(
      resolveMainHost([
        makeView("studio", { choice }),
        makeView("offline", { choice: other, connected: false }),
        makeView("old-daemon", { choice: other, supported: false }),
      ]),
    ).toEqual({ kind: "ready", mainHost: "studio", choice });
  });

  it("shows a held CLI choice without turning it into the default host", () => {
    const heldChoice = makeChoice({
      allocationId: "00000000-0000-4000-8000-000000000002",
      generation: 2,
      mainHost: "laptop",
      previousMainHost: "studio",
      setBy: { ...provenance, clientType: "cli" },
    });

    expect(
      resolveMainHost([
        makeView("studio", { choice: makeChoice() }),
        makeView("laptop", { choice: heldChoice, held: true }),
      ]),
    ).toEqual({ kind: "held", mainHost: null, choice: heldChoice });
  });

  it("keeps a partially confirmed delivery held until every connected host confirms it", () => {
    const choice = makeChoice();

    expect(
      resolveMainHost([makeView("studio", { choice }), makeView("laptop", { choice, held: true })]),
    ).toEqual({ kind: "held", mainHost: null, choice });
  });

  it("shows equal-generation conflict even when one conflicting choice is held", () => {
    const choice = makeChoice();
    const conflicting = makeChoice({
      allocationId: "00000000-0000-4000-8000-000000000002",
      mainHost: "laptop",
    });

    expect(
      resolveMainHost([
        makeView("studio", { choice }),
        makeView("laptop", { choice: conflicting, held: true }),
      ]),
    ).toEqual({ kind: "disagree", mainHost: null });
  });

  it("does not hide equal-generation allocations behind a shared target host", () => {
    const choice = makeChoice();
    const competingAllocation = makeChoice({
      allocationId: "00000000-0000-4000-8000-000000000002",
      allocatorServerId: "laptop",
    });

    expect(
      resolveMainHost([
        makeView("studio", { choice }),
        makeView("laptop", { choice: competingAllocation }),
      ]),
    ).toEqual({ kind: "disagree", mainHost: null });
  });

  it.each([false, true])(
    "withholds the default while lower and newer confirmed views differ (reversed: %s)",
    (reversed) => {
      const oldChoice = makeChoice();
      const newerChoice = makeChoice({
        allocationId: "00000000-0000-4000-8000-000000000002",
        generation: 2,
        mainHost: "laptop",
        previousMainHost: "studio",
      });
      const views = [
        makeView("studio", { choice: oldChoice }),
        makeView("laptop", { choice: newerChoice }),
      ];

      expect(resolveMainHost(reversed ? views.toReversed() : views)).toEqual({
        kind: "disagree",
        mainHost: null,
      });
    },
  );

  it("withholds the default while a connected host still reports unset", () => {
    expect(
      resolveMainHost([makeView("studio", { choice: makeChoice() }), makeView("laptop")]),
    ).toEqual({ kind: "disagree", mainHost: null });
  });
});

describe("Main Undo retries", () => {
  const original = makeChoice({ previousMainHost: "laptop" });
  const action = {
    kind: "undo" as const,
    serverId: "studio",
    requestId: "retry-this-undo",
    choice: original,
  };
  const undone = makeChoice({
    allocationId: "00000000-0000-4000-8000-000000000002",
    generation: 2,
    requestId: action.requestId,
    mainHost: "laptop",
    undoOf: original.allocationId,
  });

  it("allows the original allocation and the same durable Undo after a lost reply or partial delivery", () => {
    expect(() => verifyMainHostUndo(action, original, [original])).not.toThrow();
    expect(() => verifyMainHostUndo(action, undone, [undone, original])).not.toThrow();
    expect(() => verifyMainHostUndo(action, undone, [undone, undone])).not.toThrow();
  });

  it.each([
    { requestId: "another-undo" },
    { allocatorServerId: "laptop" },
    { undoOf: null },
    { mainHost: "studio" },
    { generation: 3 },
  ])("refuses an unrelated allocation %j", (mismatch) => {
    const other = { ...undone, ...mismatch };
    expect(() => verifyMainHostUndo(action, other, [other])).toThrow(
      "Main host changed after this Undo was shown",
    );
  });

  it.each([1, 2, 3])("refuses a competing connected choice at generation %s", (generation) => {
    const competing = makeChoice({
      allocationId: "00000000-0000-4000-8000-000000000003",
      generation,
    });
    expect(() => verifyMainHostUndo(action, undone, [undone, competing])).toThrow(
      "Main host changed after this Undo was shown",
    );
  });
});

describe("shouldClearMainHostError", () => {
  const lostAck = new DaemonConnectionError("Transport closed (code 1005)");
  const choice = makeChoice();
  const action = { kind: "set" as const, serverId: "studio", requestId: choice.requestId };
  const ready = { kind: "ready" as const, mainHost: "studio", choice };

  it("reconciles a lost set acknowledgement only after matching confirmed readback", () => {
    expect(shouldClearMainHostError(lostAck, action, ready)).toBe(true);
    expect(
      shouldClearMainHostError(
        new DaemonConnectionError("Request timed out", "DAEMON_REQUEST_TIMEOUT"),
        action,
        ready,
      ),
    ).toBe(true);
    expect(shouldClearMainHostError(lostAck, undefined, ready)).toBe(false);
    for (const mismatch of [
      { requestId: "another-request" },
      { allocatorServerId: "laptop" },
      { mainHost: "laptop" },
    ]) {
      expect(
        shouldClearMainHostError(lostAck, action, { ...ready, choice: makeChoice(mismatch) }),
      ).toBe(false);
    }
  });

  it("requires the Undo receipt to name the original allocation and previous target", () => {
    const original = makeChoice({ previousMainHost: "laptop" });
    const undo = { kind: "undo" as const, serverId: "studio", requestId: "undo", choice: original };
    const undone = makeChoice({
      requestId: "undo",
      mainHost: "laptop",
      undoOf: original.allocationId,
    });
    expect(shouldClearMainHostError(lostAck, undo, { ...ready, choice: undone })).toBe(true);
    for (const mismatch of [{ undoOf: null }, { mainHost: "studio" }]) {
      expect(
        shouldClearMainHostError(lostAck, undo, { ...ready, choice: { ...undone, ...mismatch } }),
      ).toBe(false);
    }
  });

  it("matches the complete signed allocation for delivery, including provenance", () => {
    const delivery = { ...action, kind: "deliver" as const, choice };
    expect(shouldClearMainHostError(lostAck, delivery, ready)).toBe(true);
    for (const mismatch of [
      { receipt: "another-receipt" },
      { generation: 2 },
      { setBy: { ...provenance, clientId: "another-client" } },
    ]) {
      expect(
        shouldClearMainHostError(lostAck, delivery, { ...ready, choice: makeChoice(mismatch) }),
      ).toBe(false);
    }
    expect(shouldClearMainHostError(lostAck, { ...delivery, choice: undefined }, ready)).toBe(
      false,
    );
  });

  it("keeps uncertain, held and conflicting outcomes visible", () => {
    for (const kind of ["loading", "unavailable", "unset", "disagree"] as const) {
      expect(shouldClearMainHostError(lostAck, action, { kind, mainHost: null })).toBe(false);
    }
    expect(
      shouldClearMainHostError(lostAck, action, { kind: "held", mainHost: null, choice }),
    ).toBe(false);
  });

  it.each(["allocator_unverified", "invalid_receipt", "stale_generation", "permission_denied"])(
    "never clears the named refusal %s even if the prior state matches",
    (code) => {
      const refusal = Object.assign(new Error(code), { name: "DaemonRpcError", code });
      expect(shouldClearMainHostError(refusal, { ...action, kind: "deliver", choice }, ready)).toBe(
        false,
      );
      expect(shouldClearMainHostError(null, action, ready)).toBe(false);
    },
  );
});
