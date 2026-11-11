import { expect, test } from "vitest";
import { formatRuntimeVersionBadge } from "./runtime-version";
import { toDaemonServerInfo } from "@/stores/session-store";

test("stock and older hosts retain their version label without invented build provenance", () => {
  expect(formatRuntimeVersionBadge("0.15.0")).toBe("v0.15.0");
  expect(formatRuntimeVersionBadge("v0.14.0")).toBe("v0.14.0");
  expect(formatRuntimeVersionBadge(null)).toBeNull();
});
test("custom builds expose immutable source/build identifiers and mark modified source explicitly", () => {
  const build = {
    schemaVersion: 1 as const,
    distributionVersion: "0.15.0-impower",
    upstreamVersion: "0.15.0",
    upstreamCommit: "1".repeat(40),
    sourceCommit: "2".repeat(40),
    sourceTree: "3".repeat(40),
    sourceDirty: false,
    lockSha256: "4".repeat(64),
    buildId: "5".repeat(64),
  };
  expect(formatRuntimeVersionBadge("0.15.0-impower", build)).toBe(
    "v0.15.0-impower · 22222222/55555555",
  );
  expect(
    toDaemonServerInfo({
      status: "server_info",
      serverId: "fixture",
      hostname: null,
      version: "0.15.0-impower",
      runtimeBuild: build,
    }).runtimeBuild,
  ).toEqual(build);
  expect(formatRuntimeVersionBadge("0.15.0-impower", { ...build, sourceDirty: true })).toContain(
    "(modified)",
  );
});
