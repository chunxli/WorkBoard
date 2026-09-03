import { copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repairQueues = new Map<string, Promise<SessionRepairResult>>();

interface LegacyPermissionData {
  previousMode?: unknown;
  mode?: unknown;
  previousAllowAllPermissions?: unknown;
  allowAllPermissions?: unknown;
  previousAllowAllPermissionMode?: unknown;
  allowAllPermissionMode?: unknown;
  [key: string]: unknown;
}

interface SessionEventLike {
  type?: unknown;
  data?: LegacyPermissionData;
  [key: string]: unknown;
}

export interface SessionRepairResult {
  repairedEvents: number;
  backupPath: string | null;
  eventCount: number;
}

export class CopilotSessionInUseError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`Copilot session is still active in process ${pid}. Close that terminal and retry.`);
    this.name = "CopilotSessionInUseError";
    this.pid = pid;
  }
}

function getCopilotHome(baseDirectory?: string): string {
  return path.resolve(
    baseDirectory ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot")
  );
}

function getSessionPaths(sessionId: string, baseDirectory?: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid Copilot session ID");
  const directory = path.join(getCopilotHome(baseDirectory), "session-state", sessionId);
  return { directory, eventsPath: path.join(directory, "events.jsonl") };
}

export async function copilotSessionExists(
  sessionId: string,
  baseDirectory?: string
): Promise<boolean> {
  const { eventsPath } = getSessionPaths(sessionId, baseDirectory);
  try {
    return (await stat(eventsPath)).isFile();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

function legacyModeValue(value: unknown, field: string): boolean {
  if (value === "allow-all") return true;
  if (value === "manual") return false;
  throw new Error(`Cannot repair legacy Copilot permission mode ${field}=${JSON.stringify(value)}`);
}

export function upgradeLegacyPermissionEvent(event: unknown): {
  event: unknown;
  changed: boolean;
} {
  if (!event || typeof event !== "object") return { event, changed: false };
  const candidate = event as SessionEventLike;
  if (candidate.type !== "session.permissions_changed" || !candidate.data) {
    return { event, changed: false };
  }

  const data = candidate.data;
  const missingPrevious = typeof data.previousAllowAllPermissions !== "boolean";
  const missingCurrent = typeof data.allowAllPermissions !== "boolean";
  if (!missingPrevious && !missingCurrent) return { event, changed: false };

  const previousAllowAllPermissions = missingPrevious
    ? legacyModeValue(data.previousMode, "previousMode")
    : data.previousAllowAllPermissions as boolean;
  const allowAllPermissions = missingCurrent
    ? legacyModeValue(data.mode, "mode")
    : data.allowAllPermissions as boolean;
  const upgradedData: LegacyPermissionData = {
    ...data,
    previousAllowAllPermissions,
    allowAllPermissions,
    previousAllowAllPermissionMode:
      data.previousAllowAllPermissionMode ?? (previousAllowAllPermissions ? "on" : "off"),
    allowAllPermissionMode:
      data.allowAllPermissionMode ?? (allowAllPermissions ? "on" : "off"),
  };
  delete upgradedData.previousMode;
  delete upgradedData.mode;

  return {
    event: { ...candidate, data: upgradedData },
    changed: true,
  };
}

export function upgradeLegacySessionContent(content: string): {
  content: string;
  repairedEvents: number;
  events: unknown[];
} {
  const lines = content.split("\n");
  const events: unknown[] = [];
  let repairedEvents = 0;

  const upgradedLines = lines.map((originalLine, index) => {
    const hasCarriageReturn = originalLine.endsWith("\r");
    const line = hasCarriageReturn ? originalLine.slice(0, -1) : originalLine;
    if (!line) return originalLine;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Copilot session file contains invalid JSON at line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const upgraded = upgradeLegacyPermissionEvent(parsed);
    events.push(upgraded.event);
    if (!upgraded.changed) return originalLine;
    repairedEvents += 1;
    return `${JSON.stringify(upgraded.event)}${hasCarriageReturn ? "\r" : ""}`;
  });

  return { content: upgradedLines.join("\n"), repairedEvents, events };
}

export async function readCompatibleCopilotSessionEvents(
  sessionId: string,
  baseDirectory?: string
): Promise<unknown[]> {
  const { eventsPath } = getSessionPaths(sessionId, baseDirectory);
  const content = await readFile(eventsPath, "utf8");
  return upgradeLegacySessionContent(content).events;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertSessionNotInUse(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => []);
  const activePid = entries
    .map((entry) => /^inuse\.(\d+)\.lock$/i.exec(entry)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .find(processIsAlive);
  if (activePid !== undefined) {
    throw new CopilotSessionInUseError(activePid);
  }
}

export async function assertCopilotSessionNotInUse(
  sessionId: string,
  baseDirectory?: string
): Promise<void> {
  const { directory } = getSessionPaths(sessionId, baseDirectory);
  await assertSessionNotInUse(directory);
}

async function repairSessionEvents(
  sessionId: string,
  baseDirectory?: string
): Promise<SessionRepairResult> {
  const { directory, eventsPath } = getSessionPaths(sessionId, baseDirectory);
  await assertSessionNotInUse(directory);
  const before = await stat(eventsPath);
  const original = await readFile(eventsPath, "utf8");
  const upgraded = upgradeLegacySessionContent(original);
  if (upgraded.repairedEvents === 0) {
    return { repairedEvents: 0, backupPath: null, eventCount: upgraded.events.length };
  }

  await assertSessionNotInUse(directory);
  const after = await stat(eventsPath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error("Copilot session changed while preparing compatibility repair; retry Resume.");
  }

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${eventsPath}.workboard-backup-${suffix}`;
  const temporaryPath = `${eventsPath}.workboard-${process.pid}-${Date.now()}.tmp`;
  try {
    await copyFile(eventsPath, backupPath);
    await writeFile(temporaryPath, upgraded.content, { encoding: "utf8", flag: "wx" });
    await assertSessionNotInUse(directory);
    const beforeRename = await stat(eventsPath);
    if (beforeRename.size !== before.size || beforeRename.mtimeMs !== before.mtimeMs) {
      throw new Error("Copilot session changed while writing compatibility repair; retry Resume.");
    }
    await rename(temporaryPath, eventsPath);
    return {
      repairedEvents: upgraded.repairedEvents,
      backupPath,
      eventCount: upgraded.events.length,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function repairLegacyCopilotSessionEvents(
  sessionId: string,
  baseDirectory?: string
): Promise<SessionRepairResult> {
  const key = `${getCopilotHome(baseDirectory)}:${sessionId}`;
  const queued = repairQueues.get(key);
  if (queued) return queued;
  const repair = repairSessionEvents(sessionId, baseDirectory).finally(() => {
    if (repairQueues.get(key) === repair) repairQueues.delete(key);
  });
  repairQueues.set(key, repair);
  return repair;
}