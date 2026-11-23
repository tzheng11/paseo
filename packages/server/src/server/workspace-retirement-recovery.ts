import type { RetirementJournal, RetirementResult } from "./workspace-retirement.js";
import { hashLayoutValue } from "./workspace-layout-store.js";

export interface RecoveryConfirmation {
  effectsClosed?: boolean;
  expectedBackingGeneration?: string;
}
export interface RecoveryObservation {
  running: boolean;
  completionKnown: boolean;
  receipt: { kind: "ok" | "missing" } | { kind: "outage"; code: string };
  guards: string | null;
  backing:
    | { kind: "absent" | "present-match" | "present-unrecorded" | "present-mismatch" }
    | { kind: "unreadable"; code: string };
}
export type RecoveryDecision =
  | { kind: "replay" }
  | { kind: "settle"; result: RetirementResult; recordConfirmation: boolean }
  | { kind: "fence"; code: string }
  | { kind: "reject"; code: string; diagnostic?: string };

type Evidence = "EV0" | "EV1" | "EV2c" | "EV2t" | "EV3" | "EV4";
const destructive = (name: string) =>
  name === "remove-directory" || name.startsWith("path-teardown:");

function recoveryContradiction(record: RetirementJournal): string | null {
  const rd = record.steps["remove-directory"];
  const closure = record.effectClosures?.["remove-directory"];
  if (
    !rd &&
    (closure !== undefined ||
      (record.effectAttemptHistory?.["remove-directory"] ?? []).length > 0 ||
      record.recoveryResolutions?.["remove-directory"] !== undefined)
  )
    return "launch_evidence_without_step";
  if (
    record.recoveryEffectPending === true &&
    !Object.entries(record.steps).some(([name, state]) => state === "started" && destructive(name))
  )
    return "pending_without_started_effect";
  if (record.recoveryEffectPending === true && closure !== undefined)
    return "pending_with_recorded_closure";
  return null;
}
function recoveryBindingFailure(record: RetirementJournal): string | null {
  const saved = record.recoverySettlement;
  if (
    saved &&
    (saved.operationId !== record.operationId ||
      saved.backingGeneration !== record.backingGeneration ||
      saved.nativeGeneration !== record.nativeGeneration)
  )
    return "retirement_journal_binding_changed";
  if (
    record.backingObservations &&
    hashLayoutValue({
      observed: record.backingObservations,
      generation: record.nativeGeneration,
    }) !== record.backingGeneration
  )
    return "retirement_backing_generation_changed";
  return null;
}
function recoveryEvidence(record: RetirementJournal): Evidence {
  if (record.recoverySettlement?.schemaVersion === 2) return "EV3";
  const started = Object.entries(record.steps).filter(
    ([name, state]) => state === "started" && destructive(name),
  );
  if (started.length === 0) {
    if (!record.steps["remove-directory"]) return "EV0";
    if (record.steps["remove-directory"] === "done") return "EV1";
  }
  if (
    started.length === 1 &&
    started[0][0] === "remove-directory" &&
    record.recoveryEffectPending === false &&
    (record.effectAttemptHistory?.["remove-directory"] ?? []).length === 0
  ) {
    const closure = record.effectClosures?.["remove-directory"];
    if (closure === "closed") return "EV2c";
    if (closure === "timed_out") return "EV2t";
  }
  return "EV4";
}
function recordRefusal(record: RetirementJournal): string | null {
  const reserve = record.intents
    .flatMap((intent) => intent.mutations)
    .find((mutation) => mutation.kind === "reserve-retirement");
  if (
    !reserve ||
    reserve.kind !== "reserve-retirement" ||
    reserve.targets.some(
      (target) => record.steps[`native-archive:${target.ref.workspaceId}`] !== "done",
    ) ||
    Object.entries(record.steps).some(([name, state]) => state !== "done" && !destructive(name))
  )
    return "retirement_recovery_non_path_effect_uncertain";
  if (!Object.keys(record.steps).some(destructive) && !record.result)
    return "retirement_recovery_no_path_intent";
  return null;
}
function retainedReason(
  record: RetirementJournal,
  observation: RecoveryObservation,
  evidence: Evidence,
): string {
  if (
    Object.entries(record.steps).some(
      ([name, state]) => name.startsWith("path-teardown:") && state === "started",
    )
  )
    return "recovery_uncertain_teardown_retained";
  if (observation.backing.kind === "present-unrecorded")
    return "recovery_backing_identity_unverified";
  if (evidence === "EV0") return "recovery_removal_not_attempted";
  if (evidence === "EV2t") return "git_removal_timed_out";
  return "recovery_removal_attempt_retained";
}
function settledResult(
  record: RetirementJournal,
  observation: RecoveryObservation,
  evidence: Evidence,
): RetirementResult {
  if (evidence === "EV3") return record.recoverySettlement!.result;
  const reserve = record.intents
    .flatMap((intent) => intent.mutations)
    .find((mutation) => mutation.kind === "reserve-retirement")!;
  const archivedWorkspaceIds =
    reserve.kind === "reserve-retirement"
      ? reserve.targets.map((target) => target.ref.workspaceId)
      : [];
  const archivedAgentIds = Object.keys(record.steps)
    .filter((name) => /^(agent|snapshot):/.test(name) && record.steps[name] === "done")
    .map((name) => name.slice(name.indexOf(":") + 1));
  if (observation.backing.kind === "absent")
    return { archivedWorkspaceIds, archivedAgentIds, removedDirectory: true, slotKept: false };
  return {
    archivedWorkspaceIds,
    archivedAgentIds,
    removedDirectory: false,
    slotKept: true,
    directoryLeftBehind: {
      path: record.backingPath,
      reason: retainedReason(record, observation, evidence),
    },
  };
}

/** Ordered spec rules 1–11. This function reads only its supplied values. */
export function classifyRetirementRecovery(
  record: RetirementJournal,
  observation: RecoveryObservation,
  confirmation: RecoveryConfirmation,
): RecoveryDecision {
  if (observation.running) return { kind: "fence", code: "retirement_operation_in_progress" };
  if (observation.completionKnown) return { kind: "replay" };
  const contradiction = recoveryContradiction(record);
  if (contradiction)
    return {
      kind: "reject",
      code: "retirement_recovery_effect_closure_required",
      diagnostic: contradiction,
    };
  const binding = recoveryBindingFailure(record);
  if (binding) return { kind: "reject", code: binding };
  if (
    confirmation.effectsClosed &&
    confirmation.expectedBackingGeneration !== record.backingGeneration
  )
    return { kind: "reject", code: "retirement_recovery_confirmation_binding_required" };
  if (
    confirmation.expectedBackingGeneration &&
    confirmation.expectedBackingGeneration !== record.backingGeneration
  )
    return { kind: "reject", code: "retirement_backing_generation_changed" };
  if (observation.receipt.kind === "missing")
    return { kind: "fence", code: "retirement_archive_receipt_required" };
  if (observation.receipt.kind === "outage")
    return { kind: "fence", code: observation.receipt.code };
  const refusal = recordRefusal(record);
  if (refusal) return { kind: "reject", code: refusal };
  const evidence = recoveryEvidence(record);
  if (evidence === "EV4" && !confirmation.effectsClosed)
    return { kind: "fence", code: "retirement_recovery_effect_closure_required" };
  if (observation.guards) return { kind: "fence", code: observation.guards };
  if (observation.backing.kind === "unreadable")
    return { kind: "fence", code: observation.backing.code };
  if (observation.backing.kind === "present-mismatch")
    return { kind: "fence", code: "retirement_backing_generation_changed" };
  return {
    kind: "settle",
    result: settledResult(record, observation, evidence),
    recordConfirmation: evidence === "EV4" && confirmation.effectsClosed === true,
  };
}
