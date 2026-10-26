export interface ManagedSessionMessageOptions {
  prompt: string;
  mode: "immediate";
  attachments?: { type: "file"; path: string; displayName?: string }[];
}

export interface ManagedSessionMessageResult {
  messageId?: string;
}

export interface ManagedSessionTransport {
  send(options: ManagedSessionMessageOptions): Promise<ManagedSessionMessageResult | string | void>;
  abort(): Promise<void>;
}

export interface SteeringAcceptance {
  accepted: true;
  messageId: string | null;
}

export interface SteeringReservation {
  send(prompt: string, attachments?: ManagedSessionMessageOptions["attachments"]): Promise<SteeringAcceptance>;
  release(): void;
}

export class ManagedSessionController {
  private admissionsOpen = true;
  private idleObserved = false;
  private pendingSends = 0;
  private settled = false;
  private aborting = false;
  private completionError: Error | null = null;
  private idlePromise!: Promise<void>;
  private resolveIdle!: () => void;
  private rejectIdle!: (error: Error) => void;

  constructor(readonly transport: ManagedSessionTransport) {
    this.resetIdlePromise();
  }

  get canAcceptSteering(): boolean {
    return this.admissionsOpen && !this.idleObserved && !this.settled;
  }

  waitForIdle(): Promise<void> {
    return this.idlePromise;
  }

  reserveSteering(): SteeringReservation | null {
    if (!this.admissionsOpen || this.idleObserved || this.settled) return null;
    this.pendingSends += 1;
    let finished = false;
    let sent = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      this.pendingSends -= 1;
      if (accepted && this.idleObserved && !this.aborting) this.idleObserved = false;
      this.rejectIdleIfReady();
      this.resolveIdleIfReady();
      this.settleIfReady();
    };
    return {
      send: async (prompt, attachments) => {
        if (sent || finished) throw new Error("Steering reservation has already been used");
        sent = true;
        try {
          const result = await this.transport.send({ prompt, mode: "immediate", ...(attachments?.length ? { attachments } : {}) });
          finish(true);
          return {
            accepted: true,
            messageId: typeof result === "string" ? result : result?.messageId ?? null,
          };
        } catch (error) {
          finish(false);
          throw error;
        }
      },
      release: () => finish(false),
    };
  }

  observeIdle(): void {
    if (this.settled) return;
    this.idleObserved = true;
    this.resolveIdleIfReady();
  }

  observeError(error: Error): void {
    if (this.settled) return;
    this.admissionsOpen = false;
    this.completionError = error;
    this.rejectIdleIfReady();
    this.settleIfReady();
  }

  stopAdmission(): void {
    this.admissionsOpen = false;
  }

  continueAfterIdle(): void {
    if (!this.idleObserved || this.pendingSends !== 0 || this.settled) {
      throw new Error("Managed session is not idle and ready to continue");
    }
    this.idleObserved = false;
    this.admissionsOpen = true;
    this.resetIdlePromise();
  }

  finish(): void {
    if (this.settled) return;
    this.admissionsOpen = false;
    this.settled = true;
  }

  async abort(): Promise<void> {
    this.aborting = true;
    this.stopAdmission();
    await this.transport.abort();
    this.observeIdle();
    await this.waitForIdle();
    this.finish();
  }

  private resetIdlePromise(): void {
    this.idlePromise = new Promise<void>((resolve, reject) => {
      this.resolveIdle = resolve;
      this.rejectIdle = reject;
    });
  }

  private resolveIdleIfReady(): void {
    if (!this.completionError && this.idleObserved && this.pendingSends === 0) this.resolveIdle();
  }

  private rejectIdleIfReady(): void {
    if (this.completionError && this.pendingSends === 0) this.rejectIdle(this.completionError);
  }

  private settleIfReady(): void {
    if (this.settled || this.pendingSends > 0 || !this.completionError) return;
    this.settled = true;
  }
}

const globalForManagedRuns = globalThis as unknown as {
  managedSessionControllers?: Map<string, ManagedSessionController>;
};
const controllers = globalForManagedRuns.managedSessionControllers ?? new Map<string, ManagedSessionController>();
globalForManagedRuns.managedSessionControllers = controllers;

export function registerManagedSessionController(
  runId: string,
  controller: ManagedSessionController
): void {
  controllers.set(runId, controller);
}

export function getManagedSessionController(runId: string): ManagedSessionController | null {
  return controllers.get(runId) ?? null;
}

export function unregisterManagedSessionController(
  runId: string,
  controller: ManagedSessionController
): void {
  if (controllers.get(runId) === controller) controllers.delete(runId);
}
