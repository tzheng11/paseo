import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertHostIdentityBinding, ConnectedHosts } from "./index.js";
import { createHostClient } from "@getpaseo/client/node";
import { serializeRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createStub } from "../test-utils/class-mocks.js";

vi.mock("@getpaseo/client/node", async (original) => {
  const actual = await original<typeof import("@getpaseo/client/node")>();
  return {
    ...actual,
    createHostClient: vi.fn(() => {
      throw new Error("This fixture must not connect");
    }),
  };
});
beforeEach(() => {
  vi.mocked(createHostClient)
    .mockReset()
    .mockImplementation(() => {
      throw new Error("This fixture must not connect");
    });
});

const key = Buffer.alloc(32, 7).toString("base64");
const binding = {
  expectedServerId: "srv_hub",
  authorityKeySha256: createHash("sha256").update(key).digest("hex"),
  authorityId: "authority",
  epoch: "epoch",
};
function offer(serverId = "srv_hub", daemonPublicKeyB64 = key): string {
  return serializeRelayConnectionUri({
    offer: {
      v: 2,
      serverId,
      daemonPublicKeyB64,
      relay: { endpoint: "relay.example.test:443" },
      minimumSecurityMode: "protected",
    },
    password: "synthetic-fixture-service-credential",
  });
}
function row() {
  return {
    serverId: "srv_hub",
    connection: offer(),
    metadata: { ...binding, role: "layout-authority" },
  };
}
describe("layout authority route identity", () => {
  it("admits only the actual key-bound offer and the expected registration metadata", () => {
    expect(() => assertHostIdentityBinding(row(), binding)).not.toThrow();
    expect(() =>
      assertHostIdentityBinding({ ...row(), serverId: null }, binding, "before-connect"),
    ).not.toThrow();
    expect(() => assertHostIdentityBinding({ ...row(), serverId: null }, binding)).toThrow(
      "authority identity is not verified",
    );
  });

  it("rejects a wrong offer before registration persistence or password transmission", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "layout-route-"));
    const hosts = new ConnectedHosts(home, { serverId: "srv_replica", label: "fixture" }, binding);
    try {
      await expect(
        hosts.add(
          { connection: offer("srv_wrong"), metadata: row().metadata },
          { sourceId: "owner", manageSources: true },
        ),
      ).rejects.toMatchObject({ code: "authority_identity_mismatch" });
      expect((await hosts.list()).hosts).toEqual([]);
      await expect(readFile(path.join(home, "hosts.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(createHostClient).not.toHaveBeenCalled();
    } finally {
      await hosts.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps an authenticated relay connection private while summaries omit its secret",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "layout-private-route-"));
      vi.mocked(createHostClient).mockReturnValue(
        createStub<DaemonClient>({
          isConnected: false,
          subscribeConnectionStatus: () => () => {},
          connect: async () => {},
          close: async () => {},
        }),
      );
      const hosts = new ConnectedHosts(
        home,
        { serverId: "srv_replica", label: "fixture" },
        binding,
      );
      try {
        const saved = await hosts.add(
          { connection: offer(), metadata: row().metadata },
          { sourceId: "owner", manageSources: true },
        );
        const file = path.join(home, "hosts.json");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await readFile(file, "utf8")).toContain("synthetic-fixture-service-credential");
        expect(JSON.stringify(saved)).not.toContain("synthetic-fixture-service-credential");
        expect(JSON.stringify(await hosts.list())).not.toContain(
          "synthetic-fixture-service-credential",
        );
        expect(saved.targetDescription).toBe("relay://relay.example.test:443/srv_hub");
      } finally {
        await hosts.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
  it("rejects plaintext/TOFU routes even if all descriptive metadata claims the expected identity", () => {
    for (const connection of [
      "tcp://127.0.0.1:6768",
      "wss://example.test/ws",
      "unix:///tmp/daemon.sock",
    ])
      expect(() => assertHostIdentityBinding({ ...row(), connection }, binding)).toThrow(
        "authority identity is not verified",
      );
  });
  it("refuses a key-bound offer without client authentication and never echoes credentials", () => {
    const noPassword = offer().replace(/&password=[^&]+/, "");
    expect(() => assertHostIdentityBinding({ ...row(), connection: noPassword }, binding)).toThrow(
      "requires a private service credential",
    );
    try {
      assertHostIdentityBinding({ ...row(), serverId: "wrong" }, binding);
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-fixture-service-credential");
    }
  });
  it("rejects wrong E2EE key, target server, pinned server, authority and epoch", () => {
    const invalid = [
      { ...row(), connection: offer("srv_wrong") },
      { ...row(), connection: offer("srv_hub", Buffer.alloc(32, 8).toString("base64")) },
      { ...row(), serverId: "srv_wrong" },
      { ...row(), metadata: { ...row().metadata, authorityId: "wrong" } },
      { ...row(), metadata: { ...row().metadata, epoch: "wrong" } },
      { ...row(), metadata: { ...row().metadata, role: "ordinary-host" } },
      { ...row(), metadata: { ...row().metadata, authorityKeySha256: "0".repeat(64) } },
    ];
    for (const value of invalid)
      expect(() => assertHostIdentityBinding(value, binding)).toThrow(
        "authority identity is not verified",
      );
  });
});
