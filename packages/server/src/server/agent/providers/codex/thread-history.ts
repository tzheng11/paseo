import { CodexAppServerResponseTooLargeError } from "./app-server-transport.js";

/** The transport rejected only this history response; the session remains usable. */
export function codexHistoryReadWarning(
  error: unknown,
  threadId: string,
  mode: "legacy" | "paginated",
): string | null {
  if (!(error instanceof CodexAppServerResponseTooLargeError)) return null;
  if (mode === "paginated") return "The rest of this Codex thread's history is too large to load.";
  return (
    `This Codex thread's history is too large to load in one read. ` +
    `To move it to paginated history, archive this agent, ` +
    `run \`codex migrate-rollouts --apply --thread ${threadId}\` (Codex 0.148 or newer), ` +
    `then unarchive the agent.`
  );
}
