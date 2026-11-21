import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { isSameOrDescendantPath } from "./path-utils.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WorkspaceBackingReclaimOperationSchema,
  WorkspaceBackingReclaimInputSchema,
  type WorkspaceBackingReclaimTarget,
} from "@getpaseo/protocol/workspace-backing-reclaim";
import { WorkspaceLayoutIdentitySchema } from "@getpaseo/protocol/workspace-layout";
import {
  canonicalWorkspaceBacking,
  serializeWorkspaceBacking,
  WorkspaceBackingBusyError,
} from "./workspace-retirement-context.js";
import { hashLayoutValue, WorkspaceLayoutRefusal } from "./workspace-layout-store.js";
export const ReclaimJournalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    identity: WorkspaceLayoutIdentitySchema,
    request: WorkspaceBackingReclaimInputSchema,
    requestSha256: z.string(),
    operation: WorkspaceBackingReclaimOperationSchema,
    step: z.enum(["intent", "teardown-started", "teardown-done", "remove-started", "remove-done"]),
  })
  .superRefine((journal, ctx) => {
    const op = journal.operation;
    const consistent =
      op.state === "complete"
        ? op.terminal &&
          op.removedDirectory &&
          op.code === null &&
          op.receipt !== null &&
          journal.step === "remove-done"
        : !op.receipt &&
          (op.state === "refused"
            ? op.terminal && !op.removedDirectory && journal.step === "intent" && op.code !== null
            : !op.terminal &&
              (op.state === "pending"
                ? op.code === null && !op.removedDirectory
                : op.code !== null));
    if (!consistent) ctx.addIssue({ code: "custom", message: "Inconsistent reclaim outcome" });
  });
export type ReclaimJournal = z.infer<typeof ReclaimJournalSchema>;
export function reclaimFile(home: string, id: string): string {
  return path.join(
    home,
    "workspace-backing-reclaims",
    `${z.string().uuid().parse(id).toLowerCase()}.json`,
  );
}
export async function readReclaimJournal(home: string, id: string): Promise<ReclaimJournal | null> {
  try {
    const journal = ReclaimJournalSchema.parse(
      JSON.parse(await readFile(reclaimFile(home, id), "utf8")),
    );
    const { receipt, ...outcome } = journal.operation;
    if (
      journal.operation.operationId !== id.toLowerCase() ||
      !path.isAbsolute(journal.operation.target.path) ||
      journal.requestSha256 !== hashLayoutValue(journal.request) ||
      hashLayoutValue(journal.request.target) !== hashLayoutValue(journal.operation.target) ||
      (receipt &&
        (receipt.id !== `reclaim:${id.toLowerCase()}:${receipt.resultSha256}` ||
          receipt.requestSha256 !== journal.requestSha256 ||
          receipt.resultSha256 !== hashLayoutValue({ ...outcome, receipt: null })))
    )
      throw new WorkspaceLayoutRefusal("reclaim_journal_unverified");
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceLayoutRefusal("reclaim_journal_unverified");
  }
}
export async function backingPathsOverlap(a: string, b: string): Promise<boolean> {
  const normalize = (s: string) =>
    process.platform === "darwin" || process.platform === "win32"
      ? s.normalize("NFC").toLowerCase()
      : s;
  const [left, right] = await Promise.all([
    canonicalWorkspaceBacking(a),
    canonicalWorkspaceBacking(b),
  ]);
  const child = (p: string, c: string) => {
    const r = path.relative(normalize(p), normalize(c));
    return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
  };
  return child(left, right) || child(right, left);
}
export async function assertReclaimBackingAvailable(
  home: string,
  backing: string,
  ownId?: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(path.join(home, "workspace-backing-reclaims"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5),
      journal = await readReclaimJournal(home, id);
    if (!journal || journal.operation.operationId !== id)
      throw new WorkspaceLayoutRefusal("reclaim_journal_unverified");
    if (
      id === ownId ||
      journal.operation.state === "complete" ||
      journal.operation.state === "refused"
    )
      continue;
    if (await backingPathsOverlap(backing, journal.operation.target.path))
      throw new WorkspaceLayoutRefusal("reclaim_backing_reserved");
  }
}

/** Serialize new live cwd references with the reclaim check and physical removal. */
export async function admitReclaimReference<T>(
  home: string | undefined,
  cwd: string,
  create: () => Promise<T>,
  validateReplacement?: (target: WorkspaceBackingReclaimTarget) => Promise<void>,
  rejectIfBusy = false,
): Promise<T> {
  if (!home) return create();
  return serializeWorkspaceBacking({ paths: [cwd], rejectIfBusy }, async () => {
    await assertReclaimBackingAvailable(home, cwd);
    const directory = path.join(home, "workspace-backing-reclaims");
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const journal = await readReclaimJournal(home, file.slice(0, -5));
      if (
        journal?.operation.state !== "complete" ||
        !(await backingPathsOverlap(cwd, journal.operation.target.path))
      )
        continue;
      if (!validateReplacement)
        throw new WorkspaceLayoutRefusal("reclaim_reference_generation_required");
      await validateReplacement(journal.operation.target);
    }
    return create();
  }).catch((error) => {
    if (error instanceof WorkspaceBackingBusyError)
      throw new WorkspaceLayoutRefusal("reclaim_backing_busy");
    throw error;
  });
}

export function createReclaimAgentAdmission(
  enabled: boolean,
  home: string,
  getWorkspace: (id: string) => Promise<PersistedWorkspaceRecord | null>,
) {
  if (!enabled) return undefined;
  return function <T>(
    input: { cwd: string; workspaceId?: string },
    launch: () => Promise<T>,
  ): Promise<T> {
    return admitReclaimReference(
      home,
      input.cwd,
      launch,
      async () => {
        const row = input.workspaceId ? await getWorkspace(input.workspaceId) : null;
        if (
          !row ||
          row.archivedAt ||
          !isSameOrDescendantPath(row.worktreeRoot ?? row.cwd, input.cwd)
        )
          throw new WorkspaceLayoutRefusal("reclaim_reference_generation_changed");
      },
      true,
    );
  };
}
