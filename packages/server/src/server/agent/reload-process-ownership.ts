import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { CleanupProcess, CleanupRecoveryInput } from "./reload-cleanup-recovery.js";

const execute = promisify(execFile);
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absolutePath = z.string().refine(isAbsolute);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pid = z.number().int().gt(1);
const signedApp = z.object({
  kind: z.literal("signedApp"),
  pid,
  bundlePath: absolutePath,
  teamIdentifier: z.string().min(1),
  identifier: z.string().min(1),
});
const daemonHome = z.object({
  kind: z.literal("daemonHome"),
  pid,
  home: absolutePath,
  launchPlistPath: absolutePath,
  workerPid: pid,
  sourceFiles: z.array(absolutePath).min(1).max(8),
});
const ownerSchema = z.discriminatedUnion("kind", [signedApp, daemonHome]);
const identitySchema = z.object({
  pid,
  ppid: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  startedAtUsec: z.string().regex(/^\d+$/),
  state: z.enum(["live", "zombie"]),
  executable: absolutePath.nullable(),
  device: z.string().regex(/^\d+$/).nullable(),
  inode: z.string().regex(/^\d+$/).nullable(),
});
export const foreignCleanupOwnershipSchema = z.object({
  binding: z.object({
    home: absolutePath,
    operationId: z.string().min(1),
    agentId: z.string().min(1),
    expectedReceiptSha256: hash,
  }),
  bootUuid: z.string().min(1),
  owners: z.array(ownerSchema).min(1).max(8),
  ownerProofs: z.array(hash).min(1).max(8),
  processes: z.array(identitySchema).min(1).max(4096),
  protectedAgentRecord: z.object({
    path: absolutePath,
    bindingSha256: hash,
    provider: z.enum(["codex", "claude"]),
    nativeSessionId: z.string().min(1),
  }),
  protectedFiles: z
    .array(
      z.object({
        path: absolutePath,
        device: z.string(),
        inode: z.string(),
      }),
    )
    .min(1)
    .max(32),
});
export type ForeignCleanupOwnership = z.infer<typeof foreignCleanupOwnershipSchema>;
export type CleanupForeignOwner = z.infer<typeof ownerSchema>;
type Subject = Pick<
  CleanupRecoveryInput,
  "home" | "agentId" | "operationId" | "expectedReceiptSha256"
>;
type ProcessIdentity = z.infer<typeof identitySchema>;

function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function binding(input: Subject): Subject {
  return {
    home: input.home,
    operationId: input.operationId,
    agentId: input.agentId,
    expectedReceiptSha256: input.expectedReceiptSha256,
  };
}
function descendants(rows: CleanupProcess[], roots: number[]): Set<number> {
  const result = new Set(roots);
  let size: number;
  do {
    size = result.size;
    for (const row of rows) if (result.has(row.ppid)) result.add(row.pid);
  } while (size !== result.size);
  return result;
}

/** Compare fresh OS proof, never caller assertions or a PID/path ignore list. */
export function assertForeignCleanupOwnership(
  expected: ForeignCleanupOwnership,
  observed: ForeignCleanupOwnership,
  rows: CleanupProcess[],
  input: Subject,
): Set<number> {
  requireProof(
    JSON.stringify(expected.binding) === JSON.stringify(binding(input)),
    "Foreign ownership belongs to another reload receipt",
  );
  requireProof(
    JSON.stringify(expected) === JSON.stringify(observed),
    "Foreign process ownership changed; cleanup remains unconfirmed",
  );
  const frozen = new Map(expected.processes.map((p) => [p.pid, p]));
  requireProof(frozen.size === expected.processes.length, "Duplicate foreign process identity");
  const owners = expected.owners.map((o) => o.pid);
  requireProof(new Set(owners).size === owners.length, "Duplicate foreign owner");
  requireProof(expected.ownerProofs.length === owners.length, "Incomplete foreign owner proof");
  requireProof(
    expected.owners.every((o) => o.kind !== "daemonHome" || o.home !== input.home),
    "Same-home daemon cannot be foreign",
  );
  const forest = descendants(rows, owners);
  requireProof(
    forest.size === frozen.size && [...forest].every((p) => frozen.has(p)),
    "Foreign descendants changed; cleanup remains unconfirmed",
  );
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  for (const process of frozen.values()) {
    const row = byPid.get(process.pid);
    requireProof(row && row.ppid === process.ppid, "Foreign ancestry is incomplete or reparented");
    requireProof(row.agentId !== input.agentId, "Protected agent writer cannot be foreign");
    requireProof(
      !row.nativeSessionIds?.includes(expected.protectedAgentRecord.nativeSessionId),
      "Protected native session writer cannot be foreign",
    );
    if (!owners.includes(process.pid))
      requireProof(frozen.has(process.ppid), "Foreign ancestry is incomplete or reparented");
  }
  return forest;
}

// proc_bsdinfo is the macOS public SDK ABI (PROC_PIDTBSDINFO=3). The exact
// returned size/PID/UID are checked; no argv, environment or process memory is read.
const kernelIdentityProgram = String.raw`
import ctypes,datetime,json,os,pathlib,subprocess,sys
class Info(ctypes.Structure):
 _fields_=[(n,ctypes.c_uint32) for n in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(n,ctypes.c_uint32) for n in ['nfiles','pgid','pjobc','tdev','tpgid']]+[('nice',ctypes.c_int32),('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
out=[]
for pid in json.loads(sys.argv[1]):
 info=Info();path=ctypes.create_string_buffer(4096)
 if lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info))!=ctypes.sizeof(info):
  # libproc does not expose BSD info for unreaped zombies. ps obtains their
  # terminal state from the kernel; these have no executable or open files.
  fields=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','pid=,ppid=,uid=,stat=,lstart='],text=True,env=dict(os.environ,LC_ALL='C')).split()
  if len(fields)!=9 or int(fields[0])!=pid or int(fields[2])!=os.getuid() or not fields[3].startswith('Z'):raise RuntimeError('Process identity unavailable')
  born=datetime.datetime.strptime(' '.join(fields[4:]),'%a %b %d %H:%M:%S %Y').timestamp()
  if datetime.datetime.now().timestamp()-born<2:raise RuntimeError('Zombie identity is too recent for timestamp resolution')
  out.append(dict(pid=pid,ppid=int(fields[1]),uid=int(fields[2]),startedAtUsec=str(int(born)*1000000),state='zombie',executable=None,device=None,inode=None));continue
 if info.pid!=pid or info.uid!=os.getuid():raise RuntimeError('Process identity unavailable')
 if info.status==5:
  out.append(dict(pid=pid,ppid=info.ppid,uid=info.uid,startedAtUsec=str(info.sec*1000000+info.usec),state='zombie',executable=None,device=None,inode=None));continue
 if lib.proc_pidpath(pid,path,len(path))<=0:raise RuntimeError('Executable identity unavailable for PID '+str(pid))
 exe=pathlib.Path(path.value.decode()).resolve(strict=True);s=exe.stat()
 out.append(dict(pid=pid,ppid=info.ppid,uid=info.uid,startedAtUsec=str(info.sec*1000000+info.usec),state='live',executable=str(exe),device=str(s.st_dev),inode=str(s.st_ino)))
print(json.dumps(dict(bootUuid=subprocess.check_output(['/usr/sbin/sysctl','-n','kern.bootsessionuuid'],text=True).strip(),processes=out)))
`;

/** Pure observation; exported for an isolated actual-kernel smoke check. */
export async function readCleanupProcessIdentities(
  pids: number[],
): Promise<{ bootUuid: string; processes: ProcessIdentity[] }> {
  try {
    requireProof(process.platform === "darwin", "macOS process identity required");
    requireProof(
      pids.length > 0 && pids.length <= 4096 && pids.every((p) => Number.isInteger(p) && p > 1),
      "Invalid process identity request",
    );
    const { stdout, stderr } = await execute(
      "/usr/bin/python3",
      ["-c", kernelIdentityProgram, JSON.stringify(pids)],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    requireProof(!stderr.trim(), "Process identity observation warning");
    return z
      .object({ bootUuid: z.string().min(1), processes: z.array(identitySchema) })
      .parse(JSON.parse(stdout));
  } catch {
    throw new Error("Kernel process identities could not be verified; no receipt changed");
  }
}

async function regularFile(path: string): Promise<{ path: string; sha256: string }> {
  requireProof(
    (await realpath(path)) === path && (await lstat(path)).isFile(),
    "Ownership evidence must be a canonical regular file",
  );
  return { path, sha256: digest(await readFile(path)) };
}

/** Seal the resolved source, including package-manager directory symlinks. */
export async function readCleanupLaunchSources(
  configured: string[],
  expected: string[],
): Promise<{ path: string; sha256: string }[]> {
  const paths = configured.filter((p) => isAbsolute(p) && /\.(?:[cm]?js|sh|py)$/.test(p));
  const resolved = await Promise.all(paths.map((p) => realpath(p)));
  requireProof(
    new Set(resolved).size === expected.length && expected.every((p) => resolved.includes(p)),
    "Foreign source is not bound to every launch source file",
  );
  return Promise.all(expected.map((p) => regularFile(p)));
}

async function verifyOwner(
  owner: CleanupForeignOwner,
  input: Subject,
  processes: ProcessIdentity[],
): Promise<string> {
  const anchor = processes.find((p) => p.pid === owner.pid);
  requireProof(
    anchor && anchor.state === "live" && anchor.uid === process.getuid!(),
    "Foreign owner identity unavailable",
  );
  if (owner.kind === "signedApp") {
    requireProof(
      (await realpath(owner.bundlePath)) === owner.bundlePath,
      "App bundle must be canonical",
    );
    const executable = join(owner.bundlePath, "Contents/MacOS", basename(owner.bundlePath, ".app"));
    requireProof(anchor.executable === executable, "Signed app does not own the process anchor");
    await execute("/usr/bin/codesign", ["--verify", "--strict", owner.bundlePath], {
      timeout: 30_000,
    });
    const signature = await execute("/usr/bin/codesign", ["-dv", "--verbose=4", owner.bundlePath], {
      timeout: 15_000,
    });
    const fields = signature.stderr
      .split("\n")
      .filter((line) => /^(Identifier|TeamIdentifier|CDHash|Authority)=/.test(line));
    requireProof(
      fields.includes(`Identifier=${owner.identifier}`) &&
        fields.includes(`TeamIdentifier=${owner.teamIdentifier}`) &&
        fields.some((line) => /^CDHash=[a-f0-9]+$/.test(line)),
      "App signing identity changed",
    );
    return digest(JSON.stringify({ fields, executable: await regularFile(executable) }));
  }
  requireProof(
    (await realpath(owner.home)) === owner.home && owner.home !== (await realpath(input.home)),
    "Foreign daemon must have a canonical different home",
  );
  const launch = await regularFile(owner.launchPlistPath);
  const { stdout } = await execute(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", owner.launchPlistPath],
    { timeout: 10_000 },
  );
  const plist = z
    .object({ Label: z.string().regex(/^[a-zA-Z0-9._-]+$/), ProgramArguments: z.array(z.string()) })
    .passthrough()
    .parse(JSON.parse(stdout));
  const homeIndex = plist.ProgramArguments.indexOf("--home");
  requireProof(
    homeIndex >= 0 && plist.ProgramArguments[homeIndex + 1] === owner.home,
    "Foreign launch does not explicitly bind its home",
  );
  const service = await execute(
    "/bin/launchctl",
    ["print", `gui/${process.getuid!()}/${plist.Label}`],
    { timeout: 10_000 },
  );
  requireProof(
    Number(/^\s*pid = (\d+)\s*$/m.exec(service.stdout)?.[1]) === owner.pid,
    "Foreign launchd owner changed",
  );
  const lockPath = join(owner.home, "paseo.pid");
  const lockBytes = await readFile(lockPath);
  const lock = z
    .object({ pid, uid: z.number(), serverId: z.string().min(1) })
    .passthrough()
    .parse(JSON.parse(lockBytes.toString()));
  const members = new Map(processes.map((p) => [p.pid, p]));
  const worker = members.get(owner.workerPid);
  requireProof(
    lock.uid === anchor.uid && members.has(lock.pid) && worker?.ppid === lock.pid,
    "Foreign daemon lock/worker ancestry changed",
  );
  let parent = lock.pid;
  const visited = new Set<number>();
  while (parent !== owner.pid) {
    requireProof(
      !visited.has(parent) && members.has(parent),
      "Foreign supervisor is not owned by its launchd anchor",
    );
    visited.add(parent);
    parent = members.get(parent)!.ppid;
  }
  const sources = await readCleanupLaunchSources(plist.ProgramArguments, owner.sourceFiles);
  return digest(
    JSON.stringify({
      launch,
      lockSha256: digest(lockBytes),
      config: await regularFile(join(owner.home, "config.json")),
      sources,
    }),
  );
}

/** Refuse positive protected-file access, including aliases with the same inode. */
async function verifyNoProtectedFileAccess(
  processes: ProcessIdentity[],
  nativeSessionId: string,
  files: ForeignCleanupOwnership["protectedFiles"],
): Promise<void> {
  const pids = processes.filter((p) => p.state === "live").map((p) => p.pid);
  const { stdout, stderr } = await execute(
    "/usr/sbin/lsof",
    ["-nP", "-p", pids.join(","), "-F", "pfaDin"],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
  );
  requireProof(!stderr.trim(), "File ownership observation was incomplete");
  assertNoProtectedCleanupFileAccess(stdout, processes, nativeSessionId, files);
}

export function assertNoProtectedCleanupFileAccess(
  stdout: string,
  processes: ProcessIdentity[],
  nativeSessionId: string,
  files: ForeignCleanupOwnership["protectedFiles"],
): void {
  const pids = processes.filter((p) => p.state === "live").map((p) => p.pid);
  const seen = new Set<number>();
  const images = new Set<number>();
  let device = "",
    inode = "",
    fd = "",
    currentPid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = Number(line.slice(1));
      seen.add(currentPid);
    }
    if (line.startsWith("f")) {
      device = "";
      inode = "";
      fd = line.slice(1);
    }
    if (line.startsWith("D")) device = BigInt(line.slice(1)).toString();
    if (line.startsWith("i")) inode = line.slice(1);
    if (line.startsWith("n")) {
      const path = line.slice(1);
      requireProof(
        !path.includes(nativeSessionId) &&
          !files.some((f) => f.path === path || (f.device === device && f.inode === inode)),
        "Foreign process accesses the protected native session; cleanup remains unconfirmed",
      );
      const process = processes.find((p) => p.pid === currentPid);
      if (
        fd === "txt" &&
        process &&
        path === process.executable &&
        device === process.device &&
        inode === process.inode
      )
        images.add(currentPid);
    }
  }
  requireProof(
    pids.every((p) => seen.has(p)),
    "Foreign file ownership observation was incomplete",
  );
  requireProof(
    pids.every((p) => images.has(p)),
    "Foreign executable image does not match its observed file identity",
  );
}

/**
 * Observe actual provenance for the historical admitted reload. Signature and
 * ancestry establish origin, not universal future native-session exclusivity.
 * No signals, daemon admission, provider creation or state writes occur here.
 */
export async function observeForeignCleanupOwnership(
  input: Subject,
  owners: CleanupForeignOwner[],
  protectedAgentRecordPath: string,
  protectedNativePaths: string[],
  rows: CleanupProcess[],
): Promise<ForeignCleanupOwnership> {
  try {
    const canonicalHome = await realpath(input.home);
    requireProof(input.home === canonicalHome, "Main home must be canonical");
    const recordFile = await regularFile(protectedAgentRecordPath);
    const rel = relative(join(canonicalHome, "agents"), recordFile.path);
    requireProof(
      !rel.startsWith("..") &&
        !isAbsolute(rel) &&
        basename(recordFile.path) === `${input.agentId}.json`,
      "Protected record belongs to another agent",
    );
    const record = z
      .object({
        provider: z.enum(["codex", "claude"]),
        persistence: z.object({ sessionId: z.string().min(1) }),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(recordFile.path, "utf8")));
    const protectedFiles = [];
    for (const path of [...protectedNativePaths].sort()) {
      requireProof(
        path.includes(record.persistence.sessionId) && (await realpath(path)) === path,
        "Protected native path does not bind the saved session",
      );
      const s = await stat(path);
      requireProof(s.isFile(), "Protected native persistence file unavailable");
      protectedFiles.push({
        path,
        device: String(s.dev),
        inode: String(s.ino),
      });
    }
    const forest = [
      ...descendants(
        rows,
        owners.map((o) => o.pid),
      ),
    ].sort((a, b) => a - b);
    const first = await readCleanupProcessIdentities(forest);
    const ownerProofs = [];
    for (const owner of owners) ownerProofs.push(await verifyOwner(owner, input, first.processes));
    await verifyNoProtectedFileAccess(
      first.processes,
      record.persistence.sessionId,
      protectedFiles,
    );
    const second = await readCleanupProcessIdentities(forest);
    requireProof(
      JSON.stringify(first) === JSON.stringify(second),
      "Process identity changed during ownership observation",
    );
    const again = JSON.parse(await readFile(recordFile.path, "utf8"));
    requireProof(
      again.provider === record.provider &&
        again.persistence?.sessionId === record.persistence.sessionId,
      "Protected native session binding changed during observation",
    );
    return foreignCleanupOwnershipSchema.parse({
      binding: binding(input),
      ...second,
      owners,
      ownerProofs,
      protectedAgentRecord: {
        path: recordFile.path,
        bindingSha256: digest(
          JSON.stringify({
            provider: record.provider,
            nativeSessionId: record.persistence.sessionId,
          }),
        ),
        provider: record.provider,
        nativeSessionId: record.persistence.sessionId,
      },
      protectedFiles,
    });
  } catch (error) {
    // Subprocess exceptions can contain private output. Preserve only our own messages.
    if (
      error instanceof Error &&
      !Object.hasOwn(error, "cmd") &&
      !Object.hasOwn(error, "stdout") &&
      !Object.hasOwn(error, "stderr") &&
      error.name === "Error"
    )
      throw error;
    // eslint-disable-next-line preserve-caught-error -- execFile causes contain private output; never expose them.
    throw new Error("Foreign ownership could not be verified; no receipt changed", {
      cause: error instanceof Error ? { name: error.name } : { type: typeof error },
    });
  }
}
