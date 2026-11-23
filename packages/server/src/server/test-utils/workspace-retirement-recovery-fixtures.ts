import type { RetirementJournal, RetirementResult } from "../workspace-retirement.js";
import { hashLayoutValue } from "../workspace-layout-store.js";

export const LEGACY_RETIREMENT_FIELDS = [
  "schemaVersion",
  "identity",
  "operationId",
  "nativeGeneration",
  "backingPath",
  "backingPaths",
  "backingGeneration",
  "intents",
  "steps",
  "result",
  "closedWithoutReservation",
  "archiveTimestamp",
].sort();
export const RECOVERY_STATES = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
  "S11",
  "S12",
  "S13",
  "X1",
  "X2",
  "X3",
  "X4",
  "X5",
] as const;
export type RecoveryFixtureState = (typeof RECOVERY_STATES)[number];
export const INTEGRATION_RECOVERY_STATES = RECOVERY_STATES.filter(
  (name) => name !== "X4" && name !== "X5",
);

export function recoveryFixture(
  base: RetirementJournal,
  state: RecoveryFixtureState,
): RetirementJournal {
  const record = structuredClone(base);
  delete record.effectClosures;
  delete record.effectAttemptHistory;
  delete record.recoveryClosure;
  delete record.recoveryResolutions;
  delete record.recoverySettlement;
  record.recoveryEffectPending = false;
  record.steps["remove-directory"] = "started";
  if (["S1", "S8", "S13", "X1", "X2"].includes(state)) delete record.steps["remove-directory"];
  if (state === "S2") record.steps["remove-directory"] = "done";
  if (state === "S3" || state === "S4")
    record.effectClosures = { "remove-directory": state === "S3" ? "closed" : "timed_out" };
  if (["S5", "S6", "S11", "S12", "S13", "X2", "X3", "X4"].includes(state))
    record.recoveryEffectPending = true;
  if (["S9", "S10", "X1", "X3"].includes(state))
    record.effectClosures = { "remove-directory": "not_started" };
  if (state === "S10") record.effectAttemptHistory = { "remove-directory": ["not_started"] };
  if (state === "S11")
    record.recoveryClosure = {
      schemaVersion: 2,
      operationId: record.operationId,
      backingGeneration: record.backingGeneration,
      acknowledgedAt: "2026-11-23T12:00:00.000Z",
    };
  if (["S5", "S12", "X4"].includes(state)) {
    const result: RetirementResult = {
      archivedWorkspaceIds: ["old-a"],
      archivedAgentIds: [],
      removedDirectory: false,
      slotKept: true,
      directoryLeftBehind: {
        path: record.backingPath,
        reason: "recovery_removal_attempt_retained",
      },
    };
    record.recoverySettlement = {
      operationId: record.operationId,
      backingGeneration: record.backingGeneration,
      nativeGeneration: record.nativeGeneration,
      result,
    };
    if (state !== "S12") record.recoverySettlement.schemaVersion = 2;
    if (state === "X4") record.recoverySettlement.nativeGeneration = "different-native-generation";
  }
  if (state === "S13") record.steps[`path-teardown:${record.backingPath}`] = "started";
  if (state === "X5") record.backingGeneration = "0".repeat(64);
  if (state === "S7" || state === "S8") {
    for (const key of Object.keys(record))
      if (!LEGACY_RETIREMENT_FIELDS.includes(key))
        delete (record as unknown as Record<string, unknown>)[key];
  }
  return record;
}

export function pureRecoveryBase(): RetirementJournal {
  const identity = {
    authorityServerId: "owner",
    authorityId: "00000000-0000-4000-8000-000000000001",
    epoch: "00000000-0000-4000-8000-000000000002",
  };
  const operationId = "00000000-0000-4000-8000-000000000003";
  const backingPath = "/fixture/backing";
  const nativeGeneration = "fixture-native-generation";
  const backingObservations = [
    { path: backingPath, refs: "no-other-refs", stat: { dev: 1, ino: 2, birthtimeMs: 3 } },
  ];
  const backingGeneration = hashLayoutValue({
    observed: backingObservations,
    generation: nativeGeneration,
  });
  return {
    schemaVersion: 1,
    identity,
    operationId,
    nativeGeneration,
    backingPath,
    backingPaths: [backingPath],
    backingGeneration,
    backingObservations,
    intents: [
      {
        writerVersion: 3,
        requestId: "fixture-reserve",
        expected: { ...identity, revision: 1, phase: "active" },
        mutations: [
          {
            kind: "reserve-retirement",
            operationId,
            ownerServerId: "owner",
            backingGeneration,
            targets: [{ ref: { serverId: "owner", workspaceId: "old-a" }, revision: 1 }],
          },
        ],
      },
    ],
    steps: { "native-archive:old-a": "done", [`path-teardown:${backingPath}`]: "done" },
    result: {
      archivedWorkspaceIds: ["old-a"],
      archivedAgentIds: [],
      removedDirectory: false,
      retirement: { operationId, state: "partial", code: "retirement_partial_teardown" },
    },
    closedWithoutReservation: false,
    archiveTimestamp: "2026-11-23T12:00:00.000Z",
  };
}
