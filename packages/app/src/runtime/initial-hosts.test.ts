import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { mergeInitialHosts, readInitialHosts } from "./initial-hosts";

function makeHost(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    serverId: "mac-studio",
    label: "Mac Studio",
    appearance: { color: "none", badgeDisplay: null },
    lifecycle: {},
    connections: [
      {
        id: "relay:wss:relay.example.com:443",
        type: "relay",
        relayEndpoint: "relay.example.com:443",
        useTls: true,
        daemonPublicKeyB64: "studio-public-key",
      },
    ],
    preferredConnectionId: "relay:wss:relay.example.com:443",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("readInitialHosts", () => {
  it.each([undefined, null, {}, "[]", [{ serverId: "mac-studio" }]])(
    "ignores an absent or invalid catalogue: %j",
    (value) => {
      expect(readInitialHosts({ isWebRuntime: true, value })).toEqual([]);
    },
  );

  it("ignores the catalogue outside web", () => {
    expect(readInitialHosts({ isWebRuntime: false, value: [makeHost()] })).toEqual([]);
  });

  it("normalizes hosts and transport identifiers", () => {
    const hosts = readInitialHosts({
      isWebRuntime: true,
      value: [
        {
          serverId: " mac-studio ",
          label: " Mac Studio ",
          connections: [{ type: "directTcp", endpoint: "127.0.0.1:6767" }],
        },
      ],
    });

    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      serverId: "mac-studio",
      label: "Mac Studio",
      appearance: { color: "none", badgeDisplay: null },
      connections: [{ id: "direct:localhost:6767", endpoint: "localhost:6767" }],
      preferredConnectionId: "direct:localhost:6767",
    });
  });

  it("strips host passwords and legacy direct transport passwords", () => {
    const hosts = readInitialHosts({
      isWebRuntime: true,
      value: [
        {
          serverId: "mac-studio",
          password: "deployment-password",
          connections: [
            { type: "directTcp", endpoint: "studio.example.com:443", password: "legacy-secret" },
          ],
        },
      ],
    });

    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toHaveProperty("password");
    expect(hosts[0].connections[0]).not.toHaveProperty("password");
    expect(JSON.stringify(hosts)).not.toContain("secret");
    expect(JSON.stringify(hosts)).not.toContain("deployment-password");
  });

  it("rejects a catalogue whose host has no usable connections", () => {
    expect(
      readInitialHosts({
        isWebRuntime: true,
        value: [{ serverId: "mac-studio", connections: [{ type: "directSocket", path: " " }] }],
      }),
    ).toEqual([]);
  });

  it("combines repeated host entries without duplicate profiles", () => {
    const host = makeHost();
    const directHost = makeHost({
      connections: [{ id: "ignored", type: "directTcp", endpoint: "studio.example.com:443" }],
    });
    const hosts = readInitialHosts({ isWebRuntime: true, value: [host, directHost, host] });

    expect(hosts).toHaveLength(1);
    expect(hosts[0].connections).toHaveLength(2);
    expect(hosts[0].connections.map((connection) => connection.type)).toEqual([
      "relay",
      "directTcp",
    ]);
  });
});

describe("mergeInitialHosts", () => {
  it("registers every catalogue host in a fresh browser without a network probe", () => {
    const initial = [
      makeHost(),
      makeHost({ serverId: "offline-macbook", label: "Offline MacBook" }),
    ];

    const merged = mergeInitialHosts([], initial);

    expect(merged).toEqual(initial);
    expect(merged.map((host) => host.serverId)).toEqual(["mac-studio", "offline-macbook"]);
  });

  it("keeps an unconfigured browser's saved registry unchanged", () => {
    const saved = [makeHost()];

    expect(mergeInitialHosts(saved, [])).toBe(saved);
  });

  it("replaces managed localhost routes while preserving saved auth and presentation", () => {
    const savedHost = makeHost({
      password: "saved-password",
      label: "My Studio",
      appearance: { color: "none", badgeDisplay: "hidden" },
      connections: [{ id: "direct:localhost:6767", type: "directTcp", endpoint: "localhost:6767" }],
      preferredConnectionId: "direct:localhost:6767",
    });
    const initial = makeHost({
      password: "ignored-deployment-password",
      label: "Deployment label",
    });

    const merged = mergeInitialHosts([savedHost], [initial]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      password: "saved-password",
      label: "My Studio",
      appearance: savedHost.appearance,
      lifecycle: savedHost.lifecycle,
      createdAt: savedHost.createdAt,
      connections: initial.connections,
      preferredConnectionId: initial.preferredConnectionId,
    });
    expect(savedHost.connections[0].type).toBe("directTcp");
  });

  it("adds missing managed connections and preserves a valid saved preference", () => {
    const initial = makeHost();
    const relay = initial.connections[0];
    const direct = {
      id: "direct:studio.example.com:443",
      type: "directTcp" as const,
      endpoint: "studio.example.com:443",
      useTls: true,
    };
    initial.connections = [direct, relay];
    initial.preferredConnectionId = direct.id;
    const savedHost = makeHost();

    const merged = mergeInitialHosts([savedHost], [initial]);

    expect(merged[0].connections).toEqual([direct, relay]);
    expect(merged[0].preferredConnectionId).toBe(relay.id);
  });

  it("keeps browser-only hosts and their connections unchanged", () => {
    const extra = makeHost({ serverId: "personal-host", password: "personal-password" });
    const managed = makeHost();

    const merged = mergeInitialHosts([extra], [managed]);

    expect(merged).toHaveLength(2);
    expect(merged[0].serverId).toBe("mac-studio");
    expect(merged[1]).toBe(extra);
  });

  it("orders managed hosts by catalogue, followed by browser-only hosts in saved order", () => {
    const studio = makeHost({ password: "studio-password" });
    const m4 = makeHost({ serverId: "m4", label: "My M4" });
    const m5 = makeHost({ serverId: "m5", label: "My M5" });
    const extraFirst = makeHost({ serverId: "personal-first" });
    const extraSecond = makeHost({ serverId: "personal-second" });
    const saved = [extraFirst, m5, m4, extraSecond, studio];
    const initial = [makeHost(), makeHost({ serverId: "m4" }), makeHost({ serverId: "m5" })];

    const merged = mergeInitialHosts(saved, initial);

    expect(merged).toEqual([studio, m4, m5, extraFirst, extraSecond]);
    expect(merged[0]).toBe(studio);
    expect(merged[1]).toBe(m4);
    expect(merged[2]).toBe(m5);
    expect(mergeInitialHosts(merged, initial)).toBe(merged);
  });

  it("keeps an already canonical registry reference including browser-only hosts", () => {
    const saved = [makeHost(), makeHost({ serverId: "m4" }), makeHost({ serverId: "personal" })];
    const initial = [makeHost(), makeHost({ serverId: "m4" })];

    expect(mergeInitialHosts(saved, initial)).toBe(saved);
  });

  it("does not copy a deployment password into a new host", () => {
    const merged = mergeInitialHosts([], [makeHost({ password: "deployment-password" })]);

    expect(merged[0]).not.toHaveProperty("password");
  });

  it("returns the original registry for an identical managed connection set", () => {
    const saved = [makeHost({ label: "My Studio", password: "saved-password" })];

    expect(mergeInitialHosts(saved, [makeHost()])).toBe(saved);
  });

  it("is idempotent after refreshing managed connections", () => {
    const saved = [makeHost({ connections: [], preferredConnectionId: null })];
    const initial = [makeHost()];
    const merged = mergeInitialHosts(saved, initial);

    expect(mergeInitialHosts(merged, initial)).toBe(merged);
  });

  it("keeps one profile for a managed host repeated in saved or deployment state", () => {
    const first = makeHost({ password: "first-saved-password" });
    const merged = mergeInitialHosts([first, makeHost()], [makeHost(), makeHost()]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(first);
    expect(mergeInitialHosts(merged, [makeHost()])).toBe(merged);
  });
});
