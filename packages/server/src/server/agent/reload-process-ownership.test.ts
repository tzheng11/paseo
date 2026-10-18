import { expect, test } from "vitest";
import { mkdtemp, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertForeignCleanupOwnership,
  type ForeignCleanupOwnership,
  readCleanupProcessIdentities,
  assertNoProtectedCleanupFileAccess,
  readCleanupLaunchSources,
} from "./reload-process-ownership.js";

const subject = {
  home: "/main",
  operationId: "original",
  agentId: "target",
  expectedReceiptSha256: "a".repeat(64),
};
test("package-manager source aliases bind the resolved file and refuse retargeting or omitted launch sources", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cleanup-source-")));
  try {
    const original = join(dir, "original.js"),
      other = join(dir, "other.js"),
      alias = join(dir, "launch.js");
    await writeFile(original, "original");
    await writeFile(other, "other");
    await symlink(original, alias);
    expect((await readCleanupLaunchSources(["node", alias], [original]))[0]!.path).toBe(original);
    await rm(alias);
    await symlink(other, alias);
    await expect(readCleanupLaunchSources(["node", alias], [original])).rejects.toThrow(
      "not bound",
    );
    await expect(readCleanupLaunchSources(["node", original, other], [original])).rejects.toThrow(
      "every launch source",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const identity = (pid: number, ppid: number) => ({
  pid,
  ppid,
  uid: 501,
  startedAtUsec: String(1_000_000 + pid),
  state: "live" as const,
  executable: "/signed/app",
  device: "1",
  inode: String(pid),
});
test.each([
  [
    "boot",
    (p: ForeignCleanupOwnership) => {
      p.bootUuid = "other-boot";
    },
  ],
  [
    "PID reuse",
    (p: ForeignCleanupOwnership) => {
      p.processes[1]!.startedAtUsec = "999999999";
    },
  ],
  [
    "UID",
    (p: ForeignCleanupOwnership) => {
      p.processes[1]!.uid = 502;
    },
  ],
  [
    "executable inode",
    (p: ForeignCleanupOwnership) => {
      p.processes[1]!.inode = "999";
    },
  ],
  [
    "signing/home proof",
    (p: ForeignCleanupOwnership) => {
      p.ownerProofs[0] = "d".repeat(64);
    },
  ],
  [
    "session record",
    (p: ForeignCleanupOwnership) => {
      p.protectedAgentRecord.bindingSha256 = "d".repeat(64);
    },
  ],
  [
    "session file replacement",
    (p: ForeignCleanupOwnership) => {
      p.protectedFiles[0]!.inode = "999";
    },
  ],
] as const)("changed %s refuses the frozen ownership proof", (_label, change) => {
  const expected = proof(),
    actual = proof();
  change(actual);
  expect(() => assertForeignCleanupOwnership(expected, actual, [], subject)).toThrow(
    "ownership changed",
  );
});
test("new descendants, missing ancestors and reparented roots refuse", () => {
  const expected = proof();
  const rows = expected.processes.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    worker: false,
    providerWriter: true,
  }));
  expect(() =>
    assertForeignCleanupOwnership(
      expected,
      expected,
      [...rows, { pid: 12, ppid: 11, worker: false, providerWriter: true }],
      subject,
    ),
  ).toThrow("descendants changed");
  expect(() => assertForeignCleanupOwnership(expected, expected, rows.slice(1), subject)).toThrow(
    "incomplete or reparented",
  );
  expect(() =>
    assertForeignCleanupOwnership(
      expected,
      expected,
      [rows[0]!, { ...rows[1]!, ppid: 1 }],
      subject,
    ),
  ).toThrow("descendants changed");
});
test.each([{ agentId: "target" }, { nativeSessionIds: ["session"] }])(
  "a protected writer always overrides foreign ancestry: %j",
  (marker) => {
    const expected = proof();
    const rows = expected.processes.map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      worker: false,
      providerWriter: true,
      ...marker,
    }));
    expect(() => assertForeignCleanupOwnership(expected, expected, rows, subject)).toThrow(
      /Protected/,
    );
  },
);
test("binding and same-home daemon ownership cannot be relabelled", () => {
  const expected = proof();
  expect(() =>
    assertForeignCleanupOwnership(expected, expected, [], { ...subject, operationId: "other" }),
  ).toThrow("another reload receipt");
  expected.owners = [
    {
      kind: "daemonHome",
      pid: 10,
      workerPid: 11,
      home: subject.home,
      launchPlistPath: "/launch.plist",
      sourceFiles: ["/entry.js"],
    },
  ];
  expect(() => assertForeignCleanupOwnership(expected, expected, [], subject)).toThrow("Same-home");
});
test.runIf(process.platform === "darwin")(
  "actual kernel observation binds this process without provider creation or writes",
  async () => {
    const first = await readCleanupProcessIdentities([process.pid]);
    const second = await readCleanupProcessIdentities([process.pid]);
    expect(second).toEqual(first);
    expect(first.processes).toHaveLength(1);
    expect(first.processes[0]).toMatchObject({
      pid: process.pid,
      ppid: process.ppid,
      uid: process.getuid!(),
      state: "live",
    });
    expect(BigInt(first.processes[0]!.startedAtUsec)).toBeGreaterThan(0n);
  },
);
test("actual lsof evidence rejects protected paths, native handles and inode aliases", () => {
  const p = identity(11, 10);
  const image = "p11\nftxt\nD0x1\ni11\nn/signed/app\n";
  expect(() =>
    assertNoProtectedCleanupFileAccess(image, [p], "session", proof().protectedFiles),
  ).not.toThrow();
  for (const fd of ["f4\nau\nD0x1\ni99\nn/alias\n", "f4\nau\nD0x2\ni50\nn/other/session.jsonl\n"]) {
    expect(() =>
      assertNoProtectedCleanupFileAccess(image + fd, [p], "session", proof().protectedFiles),
    ).toThrow("protected native session");
  }
  expect(() =>
    assertNoProtectedCleanupFileAccess("p11\n", [p], "session", proof().protectedFiles),
  ).toThrow("executable image");
});
const proof = (): ForeignCleanupOwnership => ({
  binding: subject,
  bootUuid: "boot",
  owners: [
    {
      kind: "signedApp",
      pid: 10,
      bundlePath: "/signed",
      teamIdentifier: "team",
      identifier: "app",
    },
  ],
  ownerProofs: ["b".repeat(64)],
  processes: [identity(10, 1), identity(11, 10)],
  protectedAgentRecord: {
    path: "/main/agents/cwd/target.json",
    bindingSha256: "c".repeat(64),
    provider: "codex",
    nativeSessionId: "session",
  },
  protectedFiles: [{ path: "/native/session.jsonl", device: "1", inode: "99" }],
});
test("unchanged positively verified foreign ancestry can remain during historical cleanup", () => {
  const expected = proof();
  const rows = expected.processes.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    worker: false,
    providerWriter: p.pid === 11,
  }));
  expect([
    ...assertForeignCleanupOwnership(expected, structuredClone(expected), rows, subject),
  ]).toEqual([10, 11]);
});
