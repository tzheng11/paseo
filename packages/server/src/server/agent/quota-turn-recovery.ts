import { createHash } from "node:crypto";
import { z } from "zod";

export const QuotaTurnCheckpointSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  failedAt: z.string(),
  credentialGeneration: z.string().optional(),
  credentialChangedAt: z.string().optional(),
  credentialLoadedAt: z.string().optional(),
});
export type QuotaTurnCheckpoint = z.infer<typeof QuotaTurnCheckpointSchema>;

export interface CredentialChange {
  credentialGeneration: string;
  credentialChangedAt: string;
}

export function credentialChangeIsStale(
  baseline: Partial<CredentialChange>,
  change: CredentialChange,
): boolean {
  const previous = Date.parse(baseline.credentialChangedAt ?? "");
  return (
    baseline.credentialGeneration !== undefined &&
    baseline.credentialGeneration !== change.credentialGeneration &&
    Number.isFinite(previous) &&
    Date.parse(change.credentialChangedAt) <= previous
  );
}

export function quotaRecoveryRefusal(
  checkpoint: QuotaTurnCheckpoint | undefined,
  change: CredentialChange,
  now: number,
): string | null {
  const changedAt = Date.parse(change.credentialChangedAt);
  if (!Number.isFinite(changedAt) || changedAt > now) return "CREDENTIAL_CHANGE_UNCONFIRMED";
  if (!checkpoint) return "NO_QUOTA_CHECKPOINT";
  const failedAt = Date.parse(checkpoint.failedAt);
  if (!Number.isFinite(failedAt)) return "CREDENTIAL_CHANGE_UNCONFIRMED";
  if (change.credentialGeneration === checkpoint.credentialGeneration)
    return "CREDENTIAL_GENERATION_UNCHANGED";
  const loadedAt = Date.parse(checkpoint.credentialLoadedAt ?? "");
  if (Number.isFinite(loadedAt) && changedAt <= loadedAt)
    return "CREDENTIAL_CHANGE_PRECEDES_BASELINE";
  const baselineAt = Date.parse(checkpoint.credentialChangedAt ?? "");
  if (checkpoint.credentialGeneration && Number.isFinite(baselineAt)) {
    if (changedAt <= baselineAt) return "CREDENTIAL_CHANGE_PRECEDES_BASELINE";
  } else if (!Number.isFinite(loadedAt) && changedAt <= failedAt)
    return "CREDENTIAL_CHANGE_PRECEDES_FAILURE";
  return null;
}

export function quotaRecoveryMessageId(
  agentId: string,
  checkpoint: QuotaTurnCheckpoint,
  change: CredentialChange,
): string {
  return `quota-recovery-${createHash("sha256")
    .update(
      JSON.stringify([
        agentId,
        checkpoint.sessionId,
        checkpoint.turnId,
        change.credentialGeneration,
      ]),
    )
    .digest("hex")}`;
}

export const QUOTA_CONTINUATION_PROMPT =
  "Automatic quota recovery: a confirmed account change is available for this quota-limited task. " +
  "Continue the existing task from its preserved context. Check what already completed and " +
  "do not repeat completed actions. Do not restart the original task from the beginning.";
