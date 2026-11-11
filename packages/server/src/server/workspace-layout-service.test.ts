import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  WorkspaceLayoutSnapshot,
  WorkspaceLayoutCommit,
} from "@getpaseo/protocol/workspace-layout";
import { emptyWorkspaceNavigationPreferences } from "@getpaseo/protocol/workspace-layout";
import { createStub } from "./test-utils/class-mocks.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";
import { hashLayoutValue } from "./workspace-layout-store.js";

const config = {
  role: "replica" as const,
  authorityServerId: "srv_hub",
  authorityKeySha256: "a".repeat(64),
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
function snapshot(revision = 0): WorkspaceLayoutSnapshot {
  const { role: _role, authorityKeySha256: _key, ...identity } = config;
  return {
    stamp: { ...identity, phase: "active", revision },
    imports: [],
    entries: [],
    clientImports: [],
    navigation: {
      revision: 1,
      preferences: emptyWorkspaceNavigationPreferences(),
      clientSources: [],
      resolutionSha256: "0".repeat(64),
    },
  };
}
let home: string;
const services: WorkspaceLayoutService[] = [];
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paseo-layout-replica-"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((current) => current.close()));
  await rm(home, { recursive: true, force: true });
});
function service() {
  const value = new WorkspaceLayoutService({
    home,
    serverId: "srv_replica",
    config,
    failed: () => {},
  });
  services.push(value);
  return value;
}
function attach(value: WorkspaceLayoutService, read: () => Promise<WorkspaceLayoutSnapshot>) {
  const client = createStub<DaemonClient>({
    getWorkspaceLayout: vi.fn(read),
    observeWorkspaceLayout: () => ({
      subscriptionId: null,
      ready: new Promise<never>(() => {}),
      subscribe: () => () => {},
      release: async () => {},
    }),
    subscribeConnectionStatus: () => () => {},
  });
  value.attachTransport({ use: async (action) => action(client), changed: () => () => {} });
  return client;
}

it("loads an offline replica as stale/read-only and never promotes it to an authority", async () => {
  const prior = snapshot(8);
  await writeFile(path.join(home, "workspace-layout-replica.json"), JSON.stringify(prior));
  const value = service();
  await value.load();
  expect(value.cached()).toEqual({ snapshot: prior, fresh: false });
  await expect(value.inspect()).rejects.toThrow("authority_unreachable");
  await expect(value.initialize(config)).rejects.toThrow("initialize_on_authority_only");
  expect(
    JSON.parse(await readFile(path.join(home, "workspace-layout-replica.json"), "utf8")),
  ).toEqual(prior);
});

it("rejects an identity or epoch mismatch without storing it", async () => {
  const value = service();
  attach(value, async () => ({
    ...snapshot(),
    stamp: { ...snapshot().stamp, epoch: "00000000-0000-4000-8000-000000000003" },
  }));
  await expect(value.inspect()).rejects.toThrow("authority_identity_mismatch");
  expect(value.cached()).toEqual({ snapshot: null, fresh: false });
  await expect(readFile(path.join(home, "workspace-layout-replica.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects regressed and forked revisions while preserving the last canonical replica", async () => {
  const value = service();
  let current = snapshot(8);
  attach(value, async () => current);
  await value.inspect();
  current = snapshot(7);
  await expect(value.inspect()).rejects.toThrow("authority_revision_regressed");
  current = { ...snapshot(8), stamp: { ...snapshot(8).stamp, phase: "importing" } };
  await expect(value.inspect()).rejects.toThrow("authority_revision_fork");
  expect(value.cached()).toEqual({ snapshot: snapshot(8), fresh: false });
});

it("cleans up a replication observation whose first snapshot never arrives", async () => {
  const value = service();
  attach(value, async () => snapshot());
  await value.close();
  expect(value.cached().fresh).toBe(false);
});

it("forwards receipt inspection to the authority and refuses a different request or epoch", async () => {
  const value = service();
  const client = attach(value, async () => snapshot());
  const receipt = {
    requestId: "lost-ack",
    requestSha256: "b".repeat(64),
    stamp: snapshot(8).stamp,
  };
  const lookup = vi.fn(async () => receipt);
  client.getWorkspaceLayoutReceipt = lookup;
  expect(await value.findReceipt("lost-ack")).toEqual(receipt);
  expect(value.cached().snapshot).toBeNull();
  lookup.mockResolvedValueOnce({ ...receipt, requestId: "other-operation" });
  await expect(value.findReceipt("lost-ack")).rejects.toThrow("invalid_commit_receipt");
  lookup.mockResolvedValueOnce({
    ...receipt,
    stamp: { ...receipt.stamp, epoch: "00000000-0000-4000-8000-000000000003" },
  });
  await expect(value.findReceipt("lost-ack")).rejects.toThrow("authority_identity_mismatch");
});

it("does not lose a route-online change delivered while an older connection attempt is settling", async () => {
  const value = service();
  let routeChanged!: () => void;
  let rejectFirst!: (error: unknown) => void;
  let attempts = 0;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const client = createStub<DaemonClient>({
    observeWorkspaceLayout: () => ({
      subscriptionId: null,
      ready: new Promise<never>(() => {}),
      subscribe: () => () => {},
      release: async () => {},
    }),
    subscribeConnectionStatus: () => () => {},
  });
  value.attachTransport({
    changed: (listener) => {
      routeChanged = listener;
      return () => {};
    },
    use: async (action) => {
      if (++attempts === 1) await first;
      return action(client);
    },
  });
  routeChanged();
  rejectFirst(new Error("previous route offline"));
  await expect.poll(() => attempts).toBe(2);
  await value.close();
});

it("ignores an older response overtaken during the read without mistaking it for an authority rollback", async () => {
  const value = service();
  let resolveOlder!: (snapshot: WorkspaceLayoutSnapshot) => void;
  const older = new Promise<WorkspaceLayoutSnapshot>((resolve) => {
    resolveOlder = resolve;
  });
  let reads = 0;
  attach(value, async () => {
    if (++reads === 1) return snapshot(8);
    return reads === 2 ? older : snapshot(9);
  });
  await value.inspect();
  const pending = value.inspect();
  expect(await value.inspect()).toEqual(snapshot(9));
  resolveOlder(snapshot(8));
  expect(await pending).toEqual(snapshot(9));
  expect(value.cached().snapshot).toEqual(snapshot(9));
});

it("returns a known durable commit receipt even when its following read fails, with no mutation replay", async () => {
  const value = service();
  let firstRead = true;
  const client = attach(value, async () => {
    if (firstRead) {
      firstRead = false;
      return snapshot(8);
    }
    throw new Error("read disconnected after durable commit");
  });
  await value.inspect();
  const input: WorkspaceLayoutCommit = {
    requestId: "once",
    expected: snapshot(8).stamp,
    mutations: [
      {
        kind: "put",
        entry: {
          ref: { serverId: "srv_replica", workspaceId: "one" },
          projectId: "project",
          pinnedAt: null,
          superpinnedAt: null,
          parent: null,
          siblingOrder: 0,
          pinPlacement: null,
          archivedAt: null,
          revision: 0,
        },
      },
    ],
  };
  const receipt = {
    requestId: "once",
    requestSha256: hashLayoutValue(input),
    stamp: snapshot(9).stamp,
  };
  client.commitWorkspaceLayout = vi.fn(async () => ({ requestId: "once", receipt }));
  expect(await value.commit(structuredClone(input))).toEqual(receipt);
  expect(client.commitWorkspaceLayout).toHaveBeenCalledOnce();
  expect(value.cached().snapshot?.entries[0]).toMatchObject({
    ref: input.mutations[0].entry.ref,
    revision: 9,
  });
  expect(value.cached().fresh).toBe(false);
});

it("retries an uninitialized authority observation with backoff even when the connected-host link stays online", async () => {
  const value = service();
  let attempts = 0;
  let releases = 0;
  const client = createStub<DaemonClient>({
    observeWorkspaceLayout: () => ({
      subscriptionId: null,
      ready:
        ++attempts === 1
          ? Promise.reject(new Error("not_initialized"))
          : Promise.resolve(snapshot(4)),
      subscribe: () => () => {},
      release: async () => {
        releases++;
      },
    }),
    subscribeConnectionStatus: () => () => {},
  });
  value.attachTransport({ changed: () => () => {}, use: async (action) => action(client) });
  await expect.poll(() => value.cached().fresh).toBe(true);
  expect(attempts).toBe(2);
  expect(value.cached().snapshot).toEqual(snapshot(4));
  await value.close();
  expect(releases).toBe(2);
});

it("recovers a corrupt cache only from the pinned authority rather than failing boot or inventing an authority", async () => {
  const file = path.join(home, "workspace-layout-replica.json");
  await writeFile(file, "{broken");
  const value = service();
  await value.load();
  expect(value.cached()).toEqual({ snapshot: null, fresh: false });
  expect(await readFile(file, "utf8")).toBe("{broken");
  attach(value, async () => snapshot(7));
  expect(await value.inspect()).toEqual(snapshot(7));
  await expect(readFile(path.join(home, "workspace-layout.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a receipt for another payload without replaying the mutation or advancing its snapshot", async () => {
  const value = service();
  const client = attach(value, async () => snapshot(8));
  await value.inspect();
  client.commitWorkspaceLayout = vi.fn(async () => ({
    requestId: "once",
    receipt: {
      requestId: "once",
      requestSha256: "b".repeat(64),
      stamp: snapshot(9).stamp,
    },
  }));
  await expect(
    value.commit({
      requestId: "once",
      expected: snapshot(8).stamp,
      mutations: [
        {
          kind: "put",
          entry: {
            ref: { serverId: "srv_replica", workspaceId: "one" },
            projectId: "project",
            pinnedAt: null,
            superpinnedAt: null,
            parent: null,
            siblingOrder: 0,
            pinPlacement: null,
            archivedAt: null,
            revision: 0,
          },
        },
      ],
    }),
  ).rejects.toThrow("invalid_commit_receipt");
  expect(client.commitWorkspaceLayout).toHaveBeenCalledOnce();
  expect(value.cached().snapshot).toEqual(snapshot(8));
});

it("a route rejected before entering its authority client is a definite no-send refusal", async () => {
  const value = service();
  value.attachTransport({
    changed: () => () => {},
    use: async () => {
      throw new Error("route rejected before action");
    },
  });
  await expect(
    value.commit({
      requestId: "unsent",
      expected: snapshot(8).stamp,
      mutations: [
        {
          kind: "put-navigation",
          expectedRevision: 1,
          preferences: emptyWorkspaceNavigationPreferences(),
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "authority_request_not_sent" });
  expect(value.cached().snapshot).toBeNull();
});
