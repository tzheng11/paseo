import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

type ReceiptDomain = "client_capture_bytes_v1" | "native_store_bytes_v1";

export interface ReloadReceiptReference {
  domain: ReceiptDomain;
  bytes: number;
  sha256: string;
}

export interface ReloadEvidenceSubject {
  operationId: string;
  agentId: string;
  credentialGeneration: string;
  credentialChangedAt: string;
  receipt: ReloadReceiptReference;
}

export interface ReloadEvidenceHead {
  sequence: number;
  hash: string;
}

export interface ReloadEvidenceEvent {
  effectKey: string;
  edge: "intent" | "observed";
  evidenceSha256: string;
}

interface EvidenceRecord {
  version: 1;
  subjectHash: string;
  sequence: number;
  previousHash: string | null;
  event: ReloadEvidenceEvent;
  hash: string;
}

export interface ReloadEvidenceStat {
  kind: "file" | "directory" | "other";
  uid: number;
  mode: number;
  links: number;
  device: number;
  inode: number;
  size: number;
  modified: number;
  changed: number;
}

export interface ReloadEvidenceHandle {
  stat(): Promise<ReloadEvidenceStat>;
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ReloadEvidenceIO {
  canonical(path: string): Promise<string>;
  stat(path: string): Promise<ReloadEvidenceStat>;
  list(path: string): Promise<string[]>;
  open(path: string, access: "read" | "create" | "directory"): Promise<ReloadEvidenceHandle>;
}

export class ReloadEvidenceError extends Error {
  constructor(
    public readonly code: "HOLD" | "CAS_CONFLICT" | "WRITE_UNKNOWN",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReloadEvidenceError";
  }
}

function digest(domain: string, bytes: string | Uint8Array): string {
  return createHash("sha256").update(domain).update("\0").update(bytes).digest("hex");
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ReloadEvidenceError("HOLD", "A complete lowercase SHA256 is required");
  }
}

export function createReloadReceiptReference(
  domain: ReceiptDomain,
  bytes: Uint8Array,
): ReloadReceiptReference {
  const reference = {
    domain,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  reloadReceiptReferenceKey(reference);
  return reference;
}

export function reloadReceiptReferenceKey(reference: ReloadReceiptReference): string {
  if (
    !["client_capture_bytes_v1", "native_store_bytes_v1"].includes(reference.domain) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0
  ) {
    throw new ReloadEvidenceError("HOLD", "Invalid original receipt domain or length");
  }
  assertHash(reference.sha256);
  return digest(
    "reload-original-reference-v1",
    JSON.stringify({ domain: reference.domain, bytes: reference.bytes, sha256: reference.sha256 }),
  );
}

function subjectHash(subject: ReloadEvidenceSubject): string {
  for (const value of [subject.operationId, subject.agentId, subject.credentialGeneration]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 160) {
      throw new ReloadEvidenceError("HOLD", "The exact original subject is required");
    }
  }
  if (!Number.isFinite(Date.parse(subject.credentialChangedAt))) {
    throw new ReloadEvidenceError("HOLD", "The original credential timestamp is required");
  }
  return digest(
    "reload-evidence-subject-v1",
    JSON.stringify([
      subject.operationId,
      subject.agentId,
      subject.credentialGeneration,
      subject.credentialChangedAt,
      reloadReceiptReferenceKey(subject.receipt),
    ]),
  );
}

function checkedEvent(event: ReloadEvidenceEvent): ReloadEvidenceEvent {
  if (
    typeof event.effectKey !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(event.effectKey) ||
    !["intent", "observed"].includes(event.edge)
  ) {
    throw new ReloadEvidenceError("HOLD", "Invalid evidence event identity");
  }
  assertHash(event.evidenceSha256);
  return {
    effectKey: event.effectKey,
    edge: event.edge,
    evidenceSha256: event.evidenceSha256,
  };
}

function recordBytes(record: EvidenceRecord): string {
  return JSON.stringify(record);
}

function sameHead(left: ReloadEvidenceHead | null, right: ReloadEvidenceHead | null): boolean {
  return left?.sequence === right?.sequence && left?.hash === right?.hash;
}

function identity(stat: ReloadEvidenceStat): string {
  // Directory membership can change its link count during our own append.
  // Evidence files still require one link and retain that count in their identity.
  return `${stat.device}:${stat.inode}:${stat.uid}:${stat.mode}:${stat.kind === "file" ? stat.links : "directory"}`;
}

function projectStat(stat: Stats): ReloadEvidenceStat {
  let kind: ReloadEvidenceStat["kind"] = "other";
  if (stat.isFile()) kind = "file";
  else if (stat.isDirectory()) kind = "directory";
  return {
    kind,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    links: stat.nlink,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modified: stat.mtimeMs,
    changed: stat.ctimeMs,
  };
}

export function createNodeReloadEvidenceIO(): ReloadEvidenceIO {
  return {
    canonical: realpath,
    stat: async (path) => projectStat(await lstat(path)),
    list: readdir,
    async open(path, access) {
      const flags =
        access === "create"
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
          : constants.O_RDONLY |
            constants.O_NOFOLLOW |
            // Refuse a FIFO/device using the opened descriptor before reading;
            // blocking open would never reach the descriptor-kind check.
            (access === "directory" ? constants.O_DIRECTORY : constants.O_NONBLOCK);
      const handle = await open(path, flags, 0o600);
      return {
        stat: async () => projectStat(await handle.stat()),
        read: () => handle.readFile(),
        write: async (bytes) => {
          await handle.writeFile(bytes);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
}

export interface ReloadEvidenceInspection {
  head: ReloadEvidenceHead | null;
  records: number;
  durability: "not_attested" | "synced";
  operationAdmission: "unsupported";
}

interface JournalSnapshot {
  root: ReloadEvidenceStat;
  records: EvidenceRecord[];
  head: ReloadEvidenceHead | null;
}

interface ReloadEvidenceOptions {
  directory: string;
  subject: ReloadEvidenceSubject;
  io?: ReloadEvidenceIO;
}

/**
 * Passive, POSIX-only evidence storage. The caller owns an unchanged private root.
 * Immutable sequence slots are the CAS; the head is derived, not a mutable pointer.
 * Reading bytes attests no durability or writer release. Recovery syncs validated
 * records before returning a head, and never authorizes/replays a provider effect.
 */
export class ReloadOperationEvidence {
  private readonly directory: string;
  private readonly subject: string;
  private readonly io: ReloadEvidenceIO;

  constructor(options: ReloadEvidenceOptions) {
    this.directory = resolve(options.directory);
    this.subject = subjectHash(options.subject);
    this.io = options.io ?? createNodeReloadEvidenceIO();
  }

  private async root(): Promise<ReloadEvidenceStat> {
    if (typeof process.getuid !== "function") {
      throw new ReloadEvidenceError("HOLD", "POSIX ownership verification is required");
    }
    const stat = await this.io.stat(this.directory);
    if (
      stat.kind !== "directory" ||
      stat.uid !== process.getuid() ||
      stat.mode !== 0o700 ||
      (await this.io.canonical(this.directory)) !== this.directory
    ) {
      throw new ReloadEvidenceError("HOLD", "An owned canonical private directory is required");
    }
    return stat;
  }

  private checkFile(stat: ReloadEvidenceStat): void {
    if (
      stat.kind !== "file" ||
      stat.uid !== process.getuid?.() ||
      stat.mode !== 0o600 ||
      stat.links !== 1
    ) {
      throw new ReloadEvidenceError("HOLD", "Evidence must be a singly linked owned private file");
    }
  }

  private async snapshot(): Promise<JournalSnapshot> {
    const root = await this.root();
    const files = (await this.io.list(this.directory)).sort();
    const records: EvidenceRecord[] = [];
    const edges = new Set<string>();
    let head: ReloadEvidenceHead | null = null;
    for (const [index, name] of files.entries()) {
      if (name !== `${String(index + 1).padStart(12, "0")}.json`) {
        throw new ReloadEvidenceError("HOLD", "Unexpected or noncontiguous evidence file");
      }
      const handle = await this.io.open(join(this.directory, name), "read");
      let bytes: Uint8Array;
      try {
        const before = await handle.stat();
        this.checkFile(before);
        bytes = await handle.read();
        const after = await handle.stat();
        if (
          identity(before) !== identity(after) ||
          before.size !== after.size ||
          before.modified !== after.modified ||
          before.changed !== after.changed
        ) {
          throw new ReloadEvidenceError("HOLD", "Evidence changed during read");
        }
      } finally {
        await handle.close();
      }
      let parsed: EvidenceRecord;
      const text = Buffer.from(bytes).toString("utf8");
      try {
        parsed = JSON.parse(text) as EvidenceRecord;
        const event = checkedEvent(parsed.event);
        const body = {
          version: 1 as const,
          subjectHash: this.subject,
          sequence: index + 1,
          previousHash: head?.hash ?? null,
          event,
        };
        const expected = {
          ...body,
          hash: digest("reload-evidence-event-v1", JSON.stringify(body)),
        };
        if (text !== recordBytes(expected)) throw new Error("Record binding mismatch");
        parsed = expected;
      } catch (cause) {
        throw new ReloadEvidenceError("HOLD", "Invalid or ambiguous evidence record", { cause });
      }
      const edge = `${parsed.event.effectKey}:${parsed.event.edge}`;
      if (
        edges.has(edge) ||
        (parsed.event.edge === "observed" && !edges.has(`${parsed.event.effectKey}:intent`))
      ) {
        throw new ReloadEvidenceError("HOLD", "Duplicate or unowned evidence edge");
      }
      edges.add(edge);
      records.push(parsed);
      head = { sequence: parsed.sequence, hash: parsed.hash };
    }
    if (identity(root) !== identity(await this.root())) {
      throw new ReloadEvidenceError("HOLD", "Evidence directory identity changed");
    }
    return { root, records, head };
  }

  async inspect(): Promise<ReloadEvidenceInspection> {
    const snapshot = await this.snapshot();
    return {
      head: snapshot.head,
      records: snapshot.records.length,
      durability: "not_attested",
      operationAdmission: "unsupported",
    };
  }

  private async syncDirectory(root: ReloadEvidenceStat): Promise<void> {
    const handle = await this.io.open(this.directory, "directory");
    try {
      if (identity(await handle.stat()) !== identity(root)) {
        throw new ReloadEvidenceError("HOLD", "Evidence directory identity changed");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async recover(): Promise<ReloadEvidenceInspection> {
    const before = await this.snapshot();
    for (const record of before.records) {
      const name = `${String(record.sequence).padStart(12, "0")}.json`;
      const handle = await this.io.open(join(this.directory, name), "read");
      try {
        this.checkFile(await handle.stat());
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.syncDirectory(before.root);
    const after = await this.snapshot();
    if (identity(before.root) !== identity(after.root) || !sameHead(before.head, after.head)) {
      throw new ReloadEvidenceError("CAS_CONFLICT", "Evidence changed during recovery");
    }
    // Recovery establishes only storage consistency, not lifecycle/effect settlement.
    return {
      head: after.head,
      records: after.records.length,
      durability: "synced",
      operationAdmission: "unsupported",
    };
  }

  async append(
    expectedHead: ReloadEvidenceHead | null,
    input: ReloadEvidenceEvent,
  ): Promise<ReloadEvidenceHead> {
    // Own the invocation-time CAS value before validation or asynchronous I/O.
    const expected =
      expectedHead === null ? null : { sequence: expectedHead.sequence, hash: expectedHead.hash };
    if (expected !== null) {
      if (!Number.isSafeInteger(expected.sequence) || expected.sequence < 1) {
        throw new ReloadEvidenceError("HOLD", "A valid expected head is required");
      }
      assertHash(expected.hash);
    }
    const event = checkedEvent(input);
    await this.recover();
    const snapshot = await this.snapshot();
    if (!sameHead(expected, snapshot.head)) {
      throw new ReloadEvidenceError("CAS_CONFLICT", "The evidence head changed");
    }
    const prior = snapshot.records.filter((record) => record.event.effectKey === event.effectKey);
    if (
      prior.some((record) => record.event.edge === event.edge) ||
      (event.edge === "observed" && !prior.some((record) => record.event.edge === "intent"))
    ) {
      throw new ReloadEvidenceError("HOLD", "An evidence edge cannot be duplicated or invented");
    }
    const body = {
      version: 1 as const,
      subjectHash: this.subject,
      sequence: (snapshot.head?.sequence ?? 0) + 1,
      previousHash: snapshot.head?.hash ?? null,
      event,
    };
    const record = { ...body, hash: digest("reload-evidence-event-v1", JSON.stringify(body)) };
    const file = join(this.directory, `${String(body.sequence).padStart(12, "0")}.json`);
    let created = false;
    try {
      const handle = await this.io.open(file, "create");
      created = true;
      try {
        this.checkFile(await handle.stat());
        await handle.write(Buffer.from(recordBytes(record)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory(snapshot.root);
      if (identity(snapshot.root) !== identity(await this.root())) {
        throw new Error("Evidence directory changed during append");
      }
      return { sequence: record.sequence, hash: record.hash };
    } catch (cause) {
      if (!created && (cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReloadEvidenceError("CAS_CONFLICT", "The evidence sequence is already owned");
      }
      // Never remove a partial/complete slot or infer whether an effect was issued.
      throw new ReloadEvidenceError(created ? "WRITE_UNKNOWN" : "HOLD", "Evidence append refused", {
        cause,
      });
    }
  }
}
