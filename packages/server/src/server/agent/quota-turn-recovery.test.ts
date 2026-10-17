import { expect, test } from "vitest";
import { quotaRecoveryRefusal, quotaRecoveryMessageId } from "./quota-turn-recovery.js";

const failed = { turnId: "turn", sessionId: "session", failedAt: "2026-10-17T12:00:00Z" };
const next = { credentialGeneration: "B", credentialChangedAt: "2026-10-17T12:01:00Z" };
const now = Date.parse("2026-10-17T12:02:00Z");

test("an unknown baseline recovers only after a confirmed later switch", () => {
  expect(quotaRecoveryRefusal(failed, next, now)).toBeNull();
  expect(quotaRecoveryRefusal(failed, { ...next, credentialChangedAt: failed.failedAt }, now)).toBe(
    "CREDENTIAL_CHANGE_PRECEDES_FAILURE",
  );
  expect(
    quotaRecoveryRefusal(failed, { ...next, credentialChangedAt: "2026-10-17T12:03:00Z" }, now),
  ).toBe("CREDENTIAL_CHANGE_UNCONFIRMED");
});

test("a known old session can fail after a preemptive switch without becoming stranded", () => {
  const oldSession = {
    ...failed,
    credentialGeneration: "A",
    credentialChangedAt: "2026-10-17T11:00:00Z",
  };
  expect(
    quotaRecoveryRefusal(oldSession, { ...next, credentialChangedAt: "2026-10-17T11:59:00Z" }, now),
  ).toBeNull();
  expect(quotaRecoveryRefusal({ ...oldSession, credentialGeneration: "B" }, next, now)).toBe(
    "CREDENTIAL_GENERATION_UNCHANGED",
  );
  expect(
    quotaRecoveryRefusal(
      oldSession,
      { ...next, credentialChangedAt: oldSession.credentialChangedAt },
      now,
    ),
  ).toBe("CREDENTIAL_CHANGE_PRECEDES_BASELINE");
});

test("the same failed turn and credential generation retain one delivery identity", () => {
  const id = quotaRecoveryMessageId("agent", failed, next);
  expect(quotaRecoveryMessageId("agent", { ...failed }, { ...next })).toBe(id);
  expect(quotaRecoveryMessageId("agent", { ...failed, turnId: "other" }, next)).not.toBe(id);
  expect(quotaRecoveryMessageId("agent", failed, { ...next, credentialGeneration: "C" })).not.toBe(
    id,
  );
});
