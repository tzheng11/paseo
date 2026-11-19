import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WorkspaceLayoutIdentitySchema,
  WorkspaceArchiveOutcomeSchema,
  type WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout";
import { writeFileDurably } from "./atomic-file.js";
import { hashLayoutValue } from "./workspace-layout-store.js";
import { nativeGeneration, type RetirementAuthority } from "./workspace-retirement.js";
import { serializeWorkspaceBacking, nativeTransitionKey } from "./workspace-retirement-context.js";
import type { ArchiveResult } from "./workspace-archive-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";

const NativeIdentitySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  cwd: z.string(),
  worktreeRoot: z.string().nullable(),
  mainRepoRoot: z.string().nullable(),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  isPaseoOwnedWorktree: z.boolean(),
});
const JournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: WorkspaceLayoutIdentitySchema,
  ownerServerId: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  projectGeneration: z.string(),
  workspaces: z.array(NativeIdentitySchema),
  nativeGeneration: z.string(),
  retirementBackingGeneration: z.string().nullable(),
  phase: z.enum(["prepared", "native-complete", "project-remove-started", "complete"]),
  archive: WorkspaceArchiveOutcomeSchema.extend({
    archivedWorkspaceIds: z.array(z.string()),
    archivedAgentIds: z.array(z.string()),
    removedDirectory: z.boolean(),
  }).nullable(),
});
type Journal = z.infer<typeof JournalSchema>;
interface ProjectRetirementInput {
  authority: RetirementAuthority;
  projectId: string;
  requestId: string;
  getProject: () => Promise<PersistedProjectRecord | null>;
  readRecords: () => Promise<PersistedWorkspaceRecord[]>;
  archive: (workspaceIds: string[], generation: string) => Promise<ArchiveResult>;
  removeProject: () => Promise<void>;
  cleanupIcon: () => Promise<void>;
}
function projectGeneration(project: PersistedProjectRecord | null, projectId: string): string {
  return hashLayoutValue({
    projectId,
    createdAt: project?.createdAt ?? null,
    rootPath: project?.rootPath ?? null,
    projectKey: project?.projectKey ?? null,
  });
}
async function readJournal(file: string): Promise<Journal | null> {
  try {
    return JournalSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Owner completion journal, not another source of canonical membership. */
export async function retireCanonicalProject(input: ProjectRetirementInput): Promise<string[]> {
  const { authority, projectId, requestId } = input;
  const home = authority.options.home;
  const identity = WorkspaceLayoutIdentitySchema.parse(authority.options.config);
  const directory = path.join(home, "project-retirements");
  const file = path.join(directory, `${hashLayoutValue(requestId)}.json`);
  const prior = await readJournal(file);
  const initialProject = await input.getProject();
  const initial =
    prior?.workspaces ??
    (await input.readRecords()).filter(
      (record) => record.projectId === projectId && !record.archivedAt,
    );
  return serializeWorkspaceBacking(
    {
      paths: [
        ...initial.flatMap((record) => [record.cwd, record.worktreeRoot ?? record.cwd]),
        ...(initialProject?.rootPath ? [initialProject.rootPath] : []),
      ],
      keys: [
        nativeTransitionKey(home, "project", projectId),
        ...initial.map((record) => nativeTransitionKey(home, "workspace", record.workspaceId)),
      ],
    },
    async () => {
      let journal = await readJournal(file);
      const records = await input.readRecords();
      if (!journal) {
        const selected = records.filter(
          (record) => record.projectId === projectId && !record.archivedAt,
        );
        // Membership may have changed before acquisition. Obtain the complete set
        // before the first durable intent or effect; conflicting expansion refuses.
        await serializeWorkspaceBacking(
          {
            paths: selected.flatMap((record) => [record.cwd, record.worktreeRoot ?? record.cwd]),
            keys: selected.map((record) =>
              nativeTransitionKey(home, "workspace", record.workspaceId),
            ),
          },
          async () => {},
        );
        journal = {
          schemaVersion: 1,
          identity,
          ownerServerId: authority.options.serverId,
          projectId,
          requestId,
          projectGeneration: projectGeneration(await input.getProject(), projectId),
          workspaces: selected.map((record) => NativeIdentitySchema.parse(record)),
          nativeGeneration: nativeGeneration(selected),
          retirementBackingGeneration: null,
          phase: "prepared",
          archive: null,
        };
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFileDurably(file, JSON.stringify(journal));
      }
      if (
        journal.projectId !== projectId ||
        journal.requestId !== requestId ||
        journal.ownerServerId !== authority.options.serverId ||
        hashLayoutValue(journal.identity) !== hashLayoutValue(identity)
      )
        throw new Error("project_retirement_request_conflict");
      if (journal.phase === "complete")
        return journal.workspaces.map((record) => record.workspaceId);
      await finishProjectRetirement(input, journal, file);
      return journal.workspaces.map((record) => record.workspaceId);
    },
  );
}

async function finishProjectRetirement(
  input: ProjectRetirementInput,
  journal: Journal,
  file: string,
): Promise<void> {
  const persist = () => writeFileDurably(file, JSON.stringify(journal));
  const savedIds = new Set(journal.workspaces.map((record) => record.workspaceId));
  const verify = async () => {
    const records = await input.readRecords();
    const projectIds = new Set(
      records
        .filter((record) => record.projectId === journal.projectId)
        .map((record) => record.workspaceId),
    );
    const snapshot = await input.authority.inspect();
    if (
      snapshot.entries.some(
        (entry) =>
          entry.ref.serverId === input.authority.options.serverId &&
          savedIds.has(entry.ref.workspaceId) &&
          entry.projectId !== journal.projectId,
      )
    )
      throw new Error("project_retirement_generation_changed");
    await verifyArchiveReceipt(input, journal, snapshot);
    if (
      snapshot.retirements?.some(
        (operation) =>
          operation.state !== "complete" &&
          operation.targets.some(
            (target) =>
              target.ref.serverId === input.authority.options.serverId &&
              projectIds.has(target.ref.workspaceId),
          ),
      )
    )
      throw new Error("Project retirement remains fenced pending reconciliation");
    if (
      records.some(
        (record) =>
          record.projectId === journal.projectId &&
          !record.archivedAt &&
          !savedIds.has(record.workspaceId),
      )
    )
      throw new Error("project_membership_changed");
    const originals = records.filter((record) => savedIds.has(record.workspaceId));
    if (
      nativeGeneration(originals) !== journal.nativeGeneration ||
      originals.some((record) => record.projectId !== journal.projectId)
    )
      throw new Error("project_retirement_generation_changed");
    const project = await input.getProject();
    if (project && projectGeneration(project, journal.projectId) !== journal.projectGeneration)
      throw new Error("project_incarnation_changed");
    return project;
  };
  await verify();
  if (!journal.archive || journal.archive.retirement?.state === "partial") {
    journal.archive = savedIds.size
      ? await input.archive([...savedIds], journal.nativeGeneration)
      : {
          archivedWorkspaceIds: [],
          archivedAgentIds: [],
          removedDirectory: false,
        };
    await persist();
    if (
      (savedIds.size > 0 && journal.archive.retirement?.state !== "complete") ||
      journal.archive.archivedWorkspaceIds.length !== savedIds.size
    )
      throw new Error("Project retirement remains fenced pending reconciliation");
    journal.phase = "native-complete";
    await persist();
  }
  const project = await verify();
  if (project) {
    journal.phase = "project-remove-started";
    await persist();
    await input.removeProject();
    await input.cleanupIcon();
  }
  // Absence after a failed notification proves the original metadata removal;
  // never select a new incarnation or repeat its icon cleanup.
  journal.phase = "complete";
  await persist();
}

async function verifyArchiveReceipt(
  input: ProjectRetirementInput,
  journal: Journal,
  snapshot: WorkspaceLayoutSnapshot,
): Promise<void> {
  const retirement = journal.archive?.retirement;
  if (retirement?.state !== "complete") return;
  const operation = snapshot.retirements?.find((row) => row.operationId === retirement.operationId);
  if (
    !operation ||
    operation.state !== "complete" ||
    operation.ownerServerId !== input.authority.options.serverId ||
    hashLayoutValue(operation.targets.map((row) => row.ref.workspaceId).sort()) !==
      hashLayoutValue(journal.workspaces.map((row) => row.workspaceId).sort()) ||
    (journal.retirementBackingGeneration !== null &&
      journal.retirementBackingGeneration !== operation.backingGeneration)
  )
    throw new Error("project_retirement_receipt_unverified");
  const receipt = retirement.receipt
    ? await input.authority.findReceipt(retirement.receipt.requestId)
    : null;
  if (!receipt || hashLayoutValue(receipt) !== hashLayoutValue(retirement.receipt))
    throw new Error("project_retirement_receipt_unverified");
  journal.retirementBackingGeneration = operation.backingGeneration;
}
