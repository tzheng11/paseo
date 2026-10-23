/** No input was admitted: the observed turn changed before a definitive steer rejection. */
export class AgentSteerTurnChangedError extends Error {
  constructor() {
    super("Active turn changed before steering could be delivered");
    this.name = "AgentSteerTurnChangedError";
  }
}

/** The provider may have accepted this input. Keep its receipt and never replay it. */
export class AgentSteerOutcomeUnknownError extends Error {
  constructor(timeoutMs: number) {
    super(`Steering acknowledgement timed out after ${timeoutMs}ms; delivery outcome unknown`);
    this.name = "AgentSteerOutcomeUnknownError";
  }
}
