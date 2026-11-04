import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceLayoutSnapshot } from "@getpaseo/protocol/workspace-layout";
import { createStub } from "./test-utils/class-mocks.js";
import { WorkspaceLayoutService } from "./workspace-layout-service.js";

const config = {
  role: "replica" as const,
  authorityServerId: "srv_hub",
  authorityKeySha256: "a".repeat(64),
  authorityId: "00000000-0000-4000-8000-000000000001",
  epoch: "00000000-0000-4000-8000-000000000002",
};
function snapshot(revision = 0): WorkspaceLayoutSnapshot {
  const { role: _role, authorityKeySha256: _key, ...identity } = config;
  return { stamp: { ...identity, phase: "active", revision }, imports: [], entries: [] };
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
