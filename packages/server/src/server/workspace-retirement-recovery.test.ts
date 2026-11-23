import { expect, test } from "vitest";
import {
  classifyRetirementRecovery,
  type RecoveryConfirmation,
  type RecoveryObservation,
} from "./workspace-retirement-recovery.js";
import {
  RECOVERY_STATES,
  recoveryFixture,
  pureRecoveryBase,
  LEGACY_RETIREMENT_FIELDS,
  type RecoveryFixtureState,
} from "./test-utils/workspace-retirement-recovery-fixtures.js";

// Literal oracle transcribed from normative §3c. No production predicate or
// classifier is used to build these expectations. P=present-match, U=unrecorded.
const CLOSURE = "retirement_recovery_effect_closure_required";
const RETAINED = "recovery_removal_attempt_retained";
const UNVERIFIED = "recovery_backing_identity_unverified";
const ROWS = {
  S1: { proven: true, P: "recovery_removal_not_attempted", U: UNVERIFIED },
  S2: { proven: true, P: RETAINED, U: UNVERIFIED },
  S3: { proven: true, P: RETAINED, U: UNVERIFIED },
  S4: { proven: true, P: "git_removal_timed_out", U: UNVERIFIED },
  S5: { proven: true, P: RETAINED, U: RETAINED, saved: true },
  S6: { proven: false, P: RETAINED, U: UNVERIFIED },
  S7: { proven: false, P: UNVERIFIED, U: UNVERIFIED },
  S8: { proven: true, P: UNVERIFIED, U: UNVERIFIED },
  S9: { proven: false, P: RETAINED, U: UNVERIFIED },
  S10: { proven: false, P: RETAINED, U: UNVERIFIED },
  S11: { proven: false, P: RETAINED, U: UNVERIFIED },
  S12: { proven: false, P: RETAINED, U: UNVERIFIED },
  S13: {
    proven: false,
    P: "recovery_uncertain_teardown_retained",
    U: "recovery_uncertain_teardown_retained",
  },
  X1: { reject: CLOSURE, diagnostic: "launch_evidence_without_step" },
  X2: { reject: CLOSURE, diagnostic: "pending_without_started_effect" },
  X3: { reject: CLOSURE, diagnostic: "pending_with_recorded_closure" },
  X4: { reject: "retirement_journal_binding_changed" },
  X5: { reject: "retirement_backing_generation_changed" },
} as const;
const confirmations = [
  "none",
  "gen-match",
  "gen-mismatch",
  "closed-bound",
  "closed-mismatch",
  "closed-unbound",
] as const;
const backings = [
  "absent",
  "present-match",
  "present-unrecorded",
  "present-mismatch",
  "unreadable",
] as const;
const receipts = ["ok", "missing", "outage"] as const;
const conditions = receipts.flatMap((receipt) => [false, true].map((hold) => ({ receipt, hold })));
const variants = confirmations.flatMap((confirmation) =>
  backings.flatMap((backing) =>
    conditions.map(({ receipt, hold }) => ({ confirmation, backing, receipt, hold })),
  ),
);
const cells = RECOVERY_STATES.flatMap((state) =>
  variants.map((variant) => Object.assign({ state }, variant)),
);
type Cell = (typeof cells)[number];

function literalExpected(cell: Cell) {
  const row = ROWS[cell.state];
  if ("reject" in row)
    return {
      kind: "reject",
      code: row.reject,
      diagnostic: "diagnostic" in row ? row.diagnostic : undefined,
    };
  if (cell.confirmation === "closed-unbound")
    return { kind: "reject", code: "retirement_recovery_confirmation_binding_required" };
  if (["gen-mismatch", "closed-mismatch"].includes(cell.confirmation))
    return { kind: "reject", code: "retirement_backing_generation_changed" };
  if (cell.receipt === "missing")
    return { kind: "fence", code: "retirement_archive_receipt_required" };
  if (cell.receipt === "outage") return { kind: "fence", code: "fixture_receipt_outage" };
  if (!row.proven && cell.confirmation !== "closed-bound") return { kind: "fence", code: CLOSURE };
  if (cell.hold) return { kind: "fence", code: "retirement_native_hold" };
  if (cell.backing === "unreadable") return { kind: "fence", code: "fixture_stat_outage" };
  if (cell.backing === "present-mismatch")
    return { kind: "fence", code: "retirement_backing_generation_changed" };
  const recordConfirmation = !row.proven && cell.confirmation === "closed-bound";
  if (cell.state === "S5")
    return { kind: "settle", removedDirectory: false, reason: RETAINED, recordConfirmation: false };
  if (cell.backing === "absent")
    return { kind: "settle", removedDirectory: true, reason: undefined, recordConfirmation };
  return {
    kind: "settle",
    removedDirectory: false,
    reason: cell.backing === "present-unrecorded" ? row.U : row.P,
    recordConfirmation,
  };
}

function confirmationInput(cell: Cell, generation: string): RecoveryConfirmation {
  switch (cell.confirmation) {
    case "none":
      return {};
    case "gen-match":
      return { expectedBackingGeneration: generation };
    case "gen-mismatch":
      return { expectedBackingGeneration: "0".repeat(64) };
    case "closed-bound":
      return { effectsClosed: true, expectedBackingGeneration: generation };
    case "closed-mismatch":
      return { effectsClosed: true, expectedBackingGeneration: "0".repeat(64) };
    case "closed-unbound":
      return { effectsClosed: true };
  }
}
function observationInput(cell: Cell): RecoveryObservation {
  const legacyMatch = cell.backing === "present-match" && ["S7", "S8"].includes(cell.state);
  const backing = legacyMatch ? "present-unrecorded" : cell.backing;
  return {
    running: false,
    completionKnown: false,
    guards: cell.hold ? "retirement_native_hold" : null,
    receipt:
      cell.receipt === "outage"
        ? { kind: "outage", code: "fixture_receipt_outage" }
        : { kind: cell.receipt },
    backing:
      backing === "unreadable"
        ? { kind: "unreadable", code: "fixture_stat_outage" }
        : { kind: backing },
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function unitRecord(state: RecoveryFixtureState, backing: Cell["backing"]) {
  const record = recoveryFixture(pureRecoveryBase(), state);
  if (backing === "present-unrecorded" && state !== "X5") delete record.backingObservations;
  return record;
}

test.each(cells)(
  "B unit $state confirmation=$confirmation backing=$backing receipt=$receipt hold=$hold",
  (cell) => {
    const record = freeze(unitRecord(cell.state, cell.backing));
    const observation = freeze(observationInput(cell));
    const confirmation = freeze(confirmationInput(cell, record.backingGeneration));
    const decision = classifyRetirementRecovery(record, observation, confirmation);
    const expected = literalExpected(cell);
    if (decision.kind === "settle") {
      expect({
        kind: decision.kind,
        removedDirectory: decision.result.removedDirectory,
        reason: decision.result.directoryLeftBehind?.reason,
        recordConfirmation: decision.recordConfirmation,
      }).toEqual(expected);
      expect(decision.result.slotKept).toBe(!decision.result.removedDirectory);
    } else
      expect(decision).toEqual(
        Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)),
      );
  },
);

test("B rules 1/2 precede all contradictory evidence and confirmation access", () => {
  const record = recoveryFixture(pureRecoveryBase(), "X3");
  const confirmation = new Proxy(
    {},
    {
      get: () => {
        throw Error("confirmation must not be read");
      },
    },
  );
  const observation = observationInput(cells[0]);
  expect(
    classifyRetirementRecovery(record, { ...observation, running: true }, confirmation),
  ).toEqual({ kind: "fence", code: "retirement_operation_in_progress" });
  expect(
    classifyRetirementRecovery(record, { ...observation, completionKnown: true }, confirmation),
  ).toEqual({ kind: "replay" });
  expect(classifyRetirementRecovery(record, observation, confirmation)).toEqual({
    kind: "reject",
    code: CLOSURE,
    diagnostic: "pending_with_recorded_closure",
  });
});
test("B rule 5 rejects uncertain non-path effects and missing path intent before exit/guards", () => {
  const record = recoveryFixture(pureRecoveryBase(), "S6");
  record.steps["agent:uncertain"] = "started";
  const observation = observationInput(cells[0]);
  expect(classifyRetirementRecovery(record, observation, {})).toEqual({
    kind: "reject",
    code: "retirement_recovery_non_path_effect_uncertain",
  });
  delete record.steps["agent:uncertain"];
  delete record.steps["remove-directory"];
  delete record.steps[`path-teardown:${record.backingPath}`];
  record.result = null;
  record.recoveryEffectPending = false;
  expect(classifyRetirementRecovery(record, observation, {})).toEqual({
    kind: "reject",
    code: "retirement_recovery_no_path_intent",
  });
});
test("B S7 is the exact live 9419 twelve-field shape", () => {
  expect(Object.keys(recoveryFixture(pureRecoveryBase(), "S7")).sort()).toEqual(
    LEGACY_RETIREMENT_FIELDS,
  );
});
