export class CaseIqIntegrationError extends Error {
  constructor(message: string, readonly status = 409, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaseIqIntegrationError";
  }
}

export class CaseIqRunUnconfirmedError extends CaseIqIntegrationError {
  constructor(cause?: unknown, message = "CaseIQ could not confirm that its owned process stopped. This Work remains reserved; retry cancellation and inspect local diagnostics.") {
    super(message, 409, { cause });
    this.name = "CaseIqRunUnconfirmedError";
  }
}

export function caseIqStopAlreadyRequested(): CaseIqIntegrationError {
  return new CaseIqIntegrationError("CaseIQ already recorded a different stop request. Refresh the Run for its status.", 409);
}

export function caseIqRunAlreadyFinalizing(): CaseIqIntegrationError {
  return new CaseIqIntegrationError("CaseIQ already reported exit and is finalizing. Refresh the Run for its final status.", 409);
}
