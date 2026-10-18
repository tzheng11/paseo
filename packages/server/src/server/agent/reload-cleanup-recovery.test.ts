import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquirePidLock, releasePidLock } from "../pid-lock.js";
import {
  readCleanupProcessCensus,
  assertCleanupCensus,
  parseCleanupProcessCensus,
  reconcileStoppedReloadCleanup,
} from "./reload-cleanup-recovery.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(reasonCode = "RELOAD_CLEANUP_UNCONFIRMED") {
  const home = await mkdtemp(join(tmpdir(), "reload-recovery-"));
  directories.push(home);
  const original = {
    operationId: "original-op",
    agentId: "original-agent",
    status: "unknown",
    reasonCode,
    retryable: false,
    credentialGeneration: "2026-10-17T12:00:00.000Z",
    credentialChangedAt: "2026-10-17T12:00:00.000Z",
  };
  const file = join(home, "reload-operations", `${sha256(original.operationId)}.json`);
  await mkdir(join(home, "reload-operations"));
  const bytes = JSON.stringify(original, null, 2);
  await writeFile(file, bytes);
  const launchContractFile = join(home, "launch-contract.json");
  await writeFile(join(home, "config.json"), "{}");
  await writeFile(
    launchContractFile,
    JSON.stringify({
      version: 1,
      configSha256: sha256("{}"),
      builtinProviderLaunchesVerified: true,
      noRenamedOrMarkerLosingWrappers: true,
      inspectedBy: "test-operator",
      evidence: "pinned default provider fixture",
    }),
  );
  return {
    home,
    original,
    file,
    bytes,
    input: {
      home,
      operationId: original.operationId,
      agentId: original.agentId,
      expectedReceiptSha256: sha256(bytes),
      retiredWorkerPid: 424242,
      launchContractFile,
    },
  };
}
const gone = () => {};
test("offline recovery preserves original intent and records failure, never fabricated completion or continuation", async () => {
  const f = await fixture();
  const observe = vi.fn(async () => []);
  const result = await reconcileStoppedReloadCleanup(f.input, observe, gone);
  expect(result).toEqual({
    ...f.original,
    status: "failed",
    retryable: true,
    reasonCode: "RELOAD_CLEANUP_RECONCILED",
    reason:
      "Previous cleanup is settled; replacement was not acknowledged. A new guarded attempt is permitted.",
  });
  expect(observe).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(result);
  const proof = JSON.parse(await readFile(`${f.file}.cleanup-reconciliation.json`, "utf8"));
  expect(proof).toMatchObject({
    originalReceiptSha256: sha256(f.bytes),
    resultSha256: sha256(await readFile(f.file, "utf8")),
    before: [],
    after: [],
  });
  const repeat = vi.fn(async () => {
    throw new Error("must not repeat verification/effects");
  });
  expect(await reconcileStoppedReloadCleanup(f.input, repeat, gone)).toEqual(result);
  expect(repeat).not.toHaveBeenCalled();
});
test("a live daemon lock prevents reconciliation before any observation or receipt write", async () => {
  const f = await fixture();
  const observe = vi.fn(async () => []);
  await acquirePidLock(f.home, null, { ownerPid: process.ppid });
  try {
    await expect(reconcileStoppedReloadCleanup(f.input, observe, gone)).rejects.toThrow(
      "already running",
    );
  } finally {
    await releasePidLock(f.home, { ownerPid: process.ppid });
  }
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  expect(observe).not.toHaveBeenCalled();
});
test.each([
  { pid: 40, ppid: 1, agentId: "original-agent", worker: false, providerWriter: false },
  { pid: 41, ppid: 1, worker: true, providerWriter: false },
  { pid: 42, ppid: 1, worker: false, providerWriter: true },
])(
  "live exact-agent, worker or unattributed provider refuses without changing the receipt: %j",
  async (blocker) => {
    const f = await fixture();
    await expect(
      reconcileStoppedReloadCleanup(f.input, async () => [blocker], gone),
    ).rejects.toThrow("not quiescent");
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  },
);
test("a retired worker still alive, failed census, or identity mismatch remains unknown", async () => {
  const f = await fixture();
  await expect(
    reconcileStoppedReloadCleanup(
      f.input,
      async () => [],
      () => {
        throw new Error("still alive");
      },
    ),
  ).rejects.toThrow("still alive");
  await expect(
    reconcileStoppedReloadCleanup(
      f.input,
      async () => {
        throw new Error("census timed out");
      },
      gone,
    ),
  ).rejects.toThrow("timed out");
  await expect(
    reconcileStoppedReloadCleanup({ ...f.input, agentId: "wrong" }, async () => [], gone),
  ).rejects.toThrow("identity mismatch");
  await expect(
    reconcileStoppedReloadCleanup(
      { ...f.input, expectedReceiptSha256: "f".repeat(64) },
      async () => [],
      gone,
    ),
  ).rejects.toThrow("receipt changed");
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
});
test.each([
  "QUOTA_CONTINUATION_UNKNOWN",
  "DAEMON_RESTARTED",
  "RELOAD_STARTUP_UNCONFIRMED",
  "RELOAD_REGISTRATION_UNCONFIRMED",
])("other uncertainty %s is never reconciled or replayed", async (code) => {
  const f = await fixture(code);
  await expect(reconcileStoppedReloadCleanup(f.input, async () => [], gone)).rejects.toThrow(
    "Only an unknown cleanup",
  );
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
});
test("late changed receipts and new census blockers abort before terminal write", async () => {
  const f = await fixture();
  let calls = 0;
  await expect(
    reconcileStoppedReloadCleanup(
      f.input,
      async () => {
        if (++calls === 2)
          return [
            {
              pid: 70,
              ppid: 1,
              worker: false,
              providerWriter: false,
              agentId: f.original.agentId,
            },
          ];
        return [];
      },
      gone,
    ),
  ).rejects.toThrow("not quiescent");
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  const changed = JSON.stringify({ ...f.original, status: "completed" });
  await expect(
    reconcileStoppedReloadCleanup(
      f.input,
      async () => {
        await writeFile(f.file, changed);
        return [];
      },
      gone,
    ),
  ).rejects.toThrow("changed during verification");
  expect(await readFile(f.file, "utf8")).toBe(changed);
});
test("proof persistence failure leaves the original unknown receipt intact", async () => {
  const f = await fixture();
  await mkdir(`${f.file}.cleanup-reconciliation.json`);
  await expect(reconcileStoppedReloadCleanup(f.input, async () => [], gone)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
});
test("process parsing emits safe ownership only and rejects incomplete output", () => {
  const rows = parseCleanupProcessCensus(
    " 40 1 /bin/codex app-server PASEO_AGENT_ID=original-agent SECRET=redacted-test\n 41 1 Paseo Daemon HOME=/tmp\n 42 1 /bin/claude\n 43 1 /bin/codex app-server PASEO_AGENT_ID=unrelated",
  );
  expect(rows).toEqual([
    { pid: 40, ppid: 1, agentId: "original-agent", worker: false, providerWriter: true },
    { pid: 41, ppid: 1, worker: true, providerWriter: false },
    { pid: 42, ppid: 1, worker: false, providerWriter: true },
    { pid: 43, ppid: 1, agentId: "unrelated", worker: false, providerWriter: true },
  ]);
  expect(() => assertCleanupCensus(rows.slice(-1), "original-agent", 999)).toThrow("not quiescent");
  expect(() =>
    parseCleanupProcessCensus(" 44 1 /bin/node script PASEO_AGENT_ID=a PASEO_AGENT_ID=b"),
  ).toThrow("Conflicting");
  expect(
    parseCleanupProcessCensus(
      " 45 1 /bin/node /x/@openai/codex/bin/codex.js app-server\n 46 1 /bin/bun /x/@anthropic-ai/claude-code/cli.js",
    ).map((p) => p.providerWriter),
  ).toEqual([true, true]);
  expect(() => parseCleanupProcessCensus("truncated environment line")).toThrow("Incomplete");
});

test("production census rejects absence of its own PID, warnings and sensitive subprocess errors", async () => {
  await expect(readCleanupProcessCensus(async () => ({ stdout: "", stderr: "" }))).rejects.toThrow(
    "could not be verified",
  );
  await expect(
    readCleanupProcessCensus(async () => ({
      stdout: `${process.pid} 1 node recovery`,
      stderr: "warning",
    })),
  ).rejects.toThrow("could not be verified");
  const error = await readCleanupProcessCensus(async () => {
    throw Object.assign(new Error("private command output"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "private",
      stderr: "private",
    });
  }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(Object.keys(error)).toEqual([]);
  expect(JSON.stringify(error)).not.toContain("private");
  expect(
    await readCleanupProcessCensus(async () => ({
      stdout: `${process.pid} 1 node recovery`,
      stderr: "",
    })),
  ).toEqual([{ pid: process.pid, ppid: 1, worker: false, providerWriter: false }]);
});
test("unsupported wrapper/configuration inspection and continuation ambiguity preserve the original receipt", async () => {
  const f = await fixture();
  const contract = JSON.parse(await readFile(f.input.launchContractFile, "utf8"));
  await writeFile(
    f.input.launchContractFile,
    JSON.stringify({ ...contract, noRenamedOrMarkerLosingWrappers: false }),
  );
  await expect(reconcileStoppedReloadCleanup(f.input, async () => [], gone)).rejects.toThrow(
    "builtin launch-contract",
  );
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  await writeFile(f.input.launchContractFile, JSON.stringify(contract));
  await writeFile(join(f.home, "config.json"), '{"changed":true}');
  await expect(reconcileStoppedReloadCleanup(f.input, async () => [], gone)).rejects.toThrow(
    "configuration changed",
  );
  expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  await writeFile(join(f.home, "config.json"), "{}");
  const bytes = JSON.stringify({
    ...f.original,
    continuation: { status: "unknown", messageId: "uncertain" },
  });
  await writeFile(f.file, bytes);
  await expect(
    reconcileStoppedReloadCleanup(
      { ...f.input, expectedReceiptSha256: sha256(bytes) },
      async () => [],
      gone,
    ),
  ).rejects.toThrow("Only an unknown cleanup");
  expect(await readFile(f.file, "utf8")).toBe(bytes);
});
test("concurrent local callers cannot share one PID lock to reconcile twice", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = reconcileStoppedReloadCleanup(
    f.input,
    async () => {
      entered();
      await gate;
      return [];
    },
    gone,
  );
  await started;
  await expect(reconcileStoppedReloadCleanup(f.input, async () => [], gone)).rejects.toThrow(
    "already in progress",
  );
  release();
  await expect(first).resolves.toMatchObject({
    status: "failed",
    reasonCode: "RELOAD_CLEANUP_RECONCILED",
  });
});
