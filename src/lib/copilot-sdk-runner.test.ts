import { describe, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { openCopilotSdkSession } from "./copilot-sdk-runner";

describe("openCopilotSdkSession", () => {
  it("creates the first session and resumes Follow Up sessions without pending work", async () => {
    const session = {} as CopilotSession;
    const createSession = vi.fn(async () => session);
    const resumeSession = vi.fn(async () => session);
    const client = { createSession, resumeSession };
    const config = { workingDirectory: "C:\\work", streaming: true };

    await openCopilotSdkSession(client, "session-1", config, false);
    expect(createSession).toHaveBeenCalledWith({ ...config, sessionId: "session-1" });
    expect(resumeSession).not.toHaveBeenCalled();

    await openCopilotSdkSession(client, "session-1", config, true);
    expect(resumeSession).toHaveBeenCalledWith("session-1", {
      ...config,
      continuePendingWork: false,
    });
  });
});