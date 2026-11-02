import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  rename,
  chmod,
  link,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeReloadEvidenceIO,
  createReloadReceiptReference,
  reloadReceiptReferenceKey,
  ReloadEvidenceError,
  ReloadOperationEvidence,
  type ReloadEvidenceIO,
  type ReloadEvidenceSubject,
} from "./reload-operation-evidence.js";

const HASH = "a".repeat(64);
const receipt = createReloadReceiptReference(
  "client_capture_bytes_v1",
  Buffer.from("fixture failed receipt"),
);
const subject: ReloadEvidenceSubject = {
  operationId: "fixture-operation",
  agentId: "fixture-agent",
  credentialGeneration: "fixture-generation",
  credentialChangedAt: "2026-10-26T01:38:06.698Z",
  receipt,
};
const intent = { effectKey: "old-close", edge: "intent" as const, evidenceSha256: HASH };
const observed = { ...intent, edge: "observed" as const };
const execFileAsync = promisify(execFile);

interface TracedIO {
  io: ReloadEvidenceIO;
  trace: string[];
}

function tracedIO(fail?: (step: string) => void): TracedIO {
  const base = createNodeReloadEvidenceIO();
  const trace: string[] = [];
  return {
    trace,
    io: {
      ...base,
      async open(path, access) {
        trace.push(`${access}:open`);
        fail?.(`${access}:open`);
        const handle = await base.open(path, access);
        return {
          ...handle,
          async write(bytes) {
            trace.push(`${access}:write`);
            fail?.(`${access}:write`);
            await handle.write(bytes);
          },
          async sync() {
            trace.push(`${access}:sync`);
            fail?.(`${access}:sync`);
            await handle.sync();
          },
          async close() {
            trace.push(`${access}:close`);
            await handle.close();
          },
        };
      },
    },
  };
}

describe.skipIf(process.platform === "win32")("passive reload evidence storage", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), "reload-evidence-h3-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function journal(io?: ReloadEvidenceIO, binding = subject): ReloadOperationEvidence {
    return new ReloadOperationEvidence({ directory, subject: binding, io });
  }

  it("separates receipt domains without changing their full raw-byte digest", () => {
    const native = createReloadReceiptReference(
      "native_store_bytes_v1",
      Buffer.from("fixture failed receipt"),
    );
    expect(native.sha256).toBe(receipt.sha256);
    expect(reloadReceiptReferenceKey(native)).not.toBe(reloadReceiptReferenceKey(receipt));
    expect(
      reloadReceiptReferenceKey({
        sha256: receipt.sha256,
        bytes: receipt.bytes,
        domain: receipt.domain,
      }),
    ).toBe(reloadReceiptReferenceKey(receipt));
  });

  it("rejects malformed original references and missing timestamps", () => {
    expect(() => reloadReceiptReferenceKey({ ...receipt, bytes: -1 })).toThrow(ReloadEvidenceError);
    expect(() => reloadReceiptReferenceKey({ ...receipt, sha256: "partial" })).toThrow(
      ReloadEvidenceError,
    );
    expect(() => journal(undefined, { ...subject, credentialChangedAt: "" })).toThrow(
      ReloadEvidenceError,
    );
  });

  it("inspects without writing, syncing, or granting operation admission", async () => {
    const port = tracedIO();
    expect(await journal(port.io).inspect()).toEqual({
      head: null,
      records: 0,
      durability: "not_attested",
      operationAdmission: "unsupported",
    });
    expect(port.trace).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("returns a head only after exclusive creation, file sync, close and directory sync", async () => {
    const port = tracedIO();
    const head = await journal(port.io).append(null, intent);
    port.trace.push("returned-head");
    expect(port.trace.slice(port.trace.indexOf("create:open"))).toEqual([
      "create:open",
      "create:write",
      "create:sync",
      "create:close",
      "directory:open",
      "directory:sync",
      "directory:close",
      "returned-head",
    ]);
    expect(head.sequence).toBe(1);
    expect(head.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
    expect((await journal().inspect()).head).toEqual(head);
  });

  it("derives and recovers the exact hash-chain head without a mutable head file", async () => {
    const store = journal();
    const first = await store.append(null, intent);
    const second = await store.append(first, observed);
    const raw = JSON.parse(await readFile(join(directory, "000000000002.json"), "utf8"));
    expect(raw.previousHash).toBe(first.hash);
    expect(await journal().recover()).toEqual({
      head: second,
      records: 2,
      durability: "synced",
      operationAdmission: "unsupported",
    });
    expect((await readdir(directory)).sort()).toEqual(["000000000001.json", "000000000002.json"]);
  });

  it("rejects a stale head before a new slot is created", async () => {
    await journal().append(null, intent);
    const port = tracedIO();
    await expect(journal(port.io).append(null, observed)).rejects.toMatchObject({
      code: "CAS_CONFLICT",
    });
    expect(port.trace.filter((step) => step.startsWith("create:"))).toEqual([]);
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
  });

  it("refuses an owned sequence FIFO without blocking inspect or recover", async () => {
    const fifo = join(directory, "000000000001.json");
    await execFileAsync("/usr/bin/mkfifo", ["-m", "600", fifo], {
      env: {},
      timeout: 1_500,
      killSignal: "SIGKILL",
    });
    const moduleUrl = new URL("./reload-operation-evidence.ts", import.meta.url).href;
    const script = `
      import { ReloadOperationEvidence } from ${JSON.stringify(moduleUrl)};
      const journal = new ReloadOperationEvidence(${JSON.stringify({ directory, subject })});
      const outcomes = [];
      for (const method of ["inspect", "recover"]) {
        try { await journal[method](); outcomes.push({ method, code: "UNEXPECTED_SUCCESS" }); }
        catch (error) { outcomes.push({ method, code: error.code }); }
      }
      process.stdout.write(JSON.stringify(outcomes));
    `;
    // A regression may block in the kernel open, so bound a disposable child rather
    // than leave a blocked libuv worker in the test runner. It owns only this fixture.
    const child = await execFileAsync(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "--eval", script],
      { cwd: directory, env: {}, timeout: 1_500, killSignal: "SIGKILL", maxBuffer: 4_096 },
    );
    expect(JSON.parse(child.stdout)).toEqual([
      { method: "inspect", code: "HOLD" },
      { method: "recover", code: "HOLD" },
    ]);
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
  });

  it("keeps the invocation-time expected head when the caller mutates it during recovery", async () => {
    const first = await journal().append(null, intent);
    const sharedHead = { ...first };
    const base = createNodeReloadEvidenceIO();
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    let creates = 0;
    const io: ReloadEvidenceIO = {
      ...base,
      async stat(path) {
        if (!blocked) {
          blocked = true;
          announce();
          await gate;
        }
        return base.stat(path);
      },
      async open(path, access) {
        if (access === "create") creates++;
        return base.open(path, access);
      },
    };
    const pending = journal(io).append(sharedHead, { ...intent, effectKey: "later-effect" });
    await entered;
    let second;
    try {
      second = await journal().append(first, observed);
      Object.assign(sharedHead, second);
    } finally {
      release();
    }
    const outcome = await pending.then(
      (head) => ({ code: "UNEXPECTED_SUCCESS", head }),
      (error: unknown) => ({ code: (error as ReloadEvidenceError).code }),
    );
    expect(await readdir(directory)).toEqual(["000000000001.json", "000000000002.json"]);
    expect(outcome).toEqual({ code: "CAS_CONFLICT" });
    expect(creates).toBe(0);
    expect((await journal().inspect()).head).toEqual(second);
  });

  it("rejects malformed head CAS inputs before any I/O", async () => {
    const port = tracedIO();
    await expect(
      journal(port.io).append({ sequence: 0, hash: HASH }, intent),
    ).rejects.toMatchObject({ code: "HOLD" });
    await expect(
      journal(port.io).append({ sequence: 1, hash: "partial" }, intent),
    ).rejects.toMatchObject({ code: "HOLD" });
    expect(port.trace).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("allows only one concurrent claimant for an immutable sequence", async () => {
    const outcomes = await Promise.allSettled([
      journal().append(null, intent),
      journal().append(null, intent),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
    expect((await journal().recover()).records).toBe(1);
  });

  it("preserves a complete slot when file sync fails and does not replay its intent", async () => {
    const port = tracedIO((step) => {
      if (step === "create:sync") throw new Error("injected file sync failure");
    });
    await expect(journal(port.io).append(null, intent)).rejects.toMatchObject({
      code: "WRITE_UNKNOWN",
    });
    const before = await readFile(join(directory, "000000000001.json"));
    expect(await journal().recover()).toMatchObject({
      records: 1,
      operationAdmission: "unsupported",
    });
    await expect(journal().append(null, intent)).rejects.toMatchObject({ code: "CAS_CONFLICT" });
    expect(await readFile(join(directory, "000000000001.json"))).toEqual(before);
  });

  it("preserves a complete slot on directory sync failure instead of claiming no effect", async () => {
    let created = false;
    const port = tracedIO((step) => {
      if (step === "create:open") created = true;
      if (created && step === "directory:sync") throw new Error("injected directory sync failure");
    });
    await expect(journal(port.io).append(null, intent)).rejects.toMatchObject({
      code: "WRITE_UNKNOWN",
    });
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
    expect(await journal().recover()).toMatchObject({
      records: 1,
      operationAdmission: "unsupported",
    });
  });

  it("retains partial bytes and refuses recovery or overwrite", async () => {
    const base = createNodeReloadEvidenceIO();
    const io: ReloadEvidenceIO = {
      ...base,
      async open(path, access) {
        const handle = await base.open(path, access);
        if (access !== "create") return handle;
        return {
          ...handle,
          async write(bytes) {
            await handle.write(bytes.slice(0, 17));
            throw new Error("injected partial write");
          },
        };
      },
    };
    await expect(journal(io).append(null, intent)).rejects.toMatchObject({ code: "WRITE_UNKNOWN" });
    const partial = await readFile(join(directory, "000000000001.json"));
    expect(partial.byteLength).toBe(17);
    await expect(journal().recover()).rejects.toMatchObject({ code: "HOLD" });
    await expect(journal().append(null, intent)).rejects.toMatchObject({ code: "HOLD" });
    expect(await readFile(join(directory, "000000000001.json"))).toEqual(partial);
  });

  it.each([
    { ...subject, operationId: "different-operation" },
    { ...subject, agentId: "different-agent" },
    { ...subject, credentialGeneration: "different-generation" },
    { ...subject, credentialChangedAt: "2026-10-26T01:38:06.699Z" },
    { ...subject, receipt: { ...receipt, sha256: "b".repeat(64) } },
    { ...subject, receipt: { ...receipt, domain: "native_store_bytes_v1" as const } },
  ])("refuses a journal rebound to a different original subject: %j", async (binding) => {
    await journal().append(null, intent);
    await expect(journal(undefined, binding).inspect()).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
  });

  it("rejects duplicate intents and observations without an owned intent", async () => {
    await expect(journal().append(null, observed)).rejects.toMatchObject({ code: "HOLD" });
    const head = await journal().append(null, intent);
    await expect(journal().append(head, intent)).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual(["000000000001.json"]);
  });

  it("holds on changed event bytes and keeps the evidence", async () => {
    await journal().append(null, intent);
    const file = join(directory, "000000000001.json");
    const changed = (await readFile(file, "utf8")).replace(HASH, "b".repeat(64));
    await writeFile(file, changed);
    await expect(journal().recover()).rejects.toMatchObject({ code: "HOLD" });
    expect(await readFile(file, "utf8")).toBe(changed);
  });

  it("does not repair gaps or unexpected files", async () => {
    await journal().append(null, intent);
    await rename(join(directory, "000000000001.json"), join(directory, "000000000002.json"));
    await expect(journal().recover()).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual(["000000000002.json"]);
  });

  it("refuses a hardlinked evidence file", async () => {
    await journal().append(null, intent);
    const file = join(directory, "000000000001.json");
    const outside = `${directory}-retained-link`;
    await link(file, outside);
    try {
      await expect(journal().recover()).rejects.toMatchObject({ code: "HOLD" });
    } finally {
      await rm(outside);
    }
  });

  it("refuses nonprivate directory permissions", async () => {
    await chmod(directory, 0o755);
    await expect(journal().append(null, intent)).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a foreign directory owner before creating evidence", async () => {
    const base = createNodeReloadEvidenceIO();
    const io: ReloadEvidenceIO = {
      ...base,
      stat: async (path) => ({ ...(await base.stat(path)), uid: (process.getuid?.() ?? 0) + 1 }),
    };
    await expect(journal(io).append(null, intent)).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a changed opened directory identity before creating evidence", async () => {
    const base = createNodeReloadEvidenceIO();
    const io: ReloadEvidenceIO = {
      ...base,
      async open(path, access) {
        const handle = await base.open(path, access);
        if (access !== "directory") return handle;
        return { ...handle, stat: async () => ({ ...(await handle.stat()), inode: -1 }) };
      },
    };
    await expect(journal(io).append(null, intent)).rejects.toMatchObject({ code: "HOLD" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses an aliased directory without touching its target", async () => {
    const alias = `${directory}-alias`;
    await symlink(directory, alias);
    try {
      const store = new ReloadOperationEvidence({ directory: alias, subject });
      await expect(store.append(null, intent)).rejects.toMatchObject({ code: "HOLD" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(alias);
    }
  });
});
