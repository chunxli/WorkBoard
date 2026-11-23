import { hostname } from "node:os";
import { isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { getManagedSessionController } from "@/lib/managed-session-controller";
import { isCaseIqWebRun } from "@/lib/runtime-provider";
import { isTerminalRunTrigger } from "@/lib/terminal-run";

export function getLocalManagedWorkRuntime(run?: {
  id: string;
  hostname: string | null;
  trigger: string;
  engine: string | null;
  providerId?: string | null;
}) {
  const owned = run?.hostname === hostname() && !isTerminalRunTrigger(run.trigger);
  return {
    controller: owned && run.engine === "SDK" ? getManagedSessionController(run.id) : null,
    native: owned && (run.engine === "CLI" || isCaseIqWebRun(run)) && isNativeCopilotRunActive(run.id),
  };
}
