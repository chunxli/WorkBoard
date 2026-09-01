-- AlterTable
ALTER TABLE "Work" ADD COLUMN "hostname" TEXT;

-- CreateTable
CREATE TABLE "TerminalLaunch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "launcherPid" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "launchedAt" DATETIME,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalLaunch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "workId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "trigger" TEXT NOT NULL,
    "engine" TEXT,
    "executionPath" TEXT,
    "promptSnapshot" TEXT,
    "finalOutput" TEXT,
    "outputDir" TEXT,
    "copilotSessionId" TEXT,
    "concurrencyMode" TEXT,
    "resumedFromRunId" TEXT,
    "branchName" TEXT,
    "baseCommit" TEXT,
    "finalCommit" TEXT,
    "logPath" TEXT,
    "outputFormat" TEXT,
    "model" TEXT,
    "contextTier" TEXT,
    "reasoningEffort" TEXT,
    "exitCode" INTEGER,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pid" INTEGER,
    "command" TEXT,
    "cpuTimeMs" INTEGER,
    "peakMemoryMb" REAL,
    "hostname" TEXT,
    CONSTRAINT "Run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_resumedFromRunId_fkey" FOREIGN KEY ("resumedFromRunId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("baseCommit", "branchName", "command", "concurrencyMode", "contextTier", "copilotSessionId", "cpuTimeMs", "createdAt", "engine", "errorMessage", "executionPath", "exitCode", "finalCommit", "finalOutput", "finishedAt", "hostname", "id", "logPath", "model", "outputDir", "outputFormat", "peakMemoryMb", "pid", "promptSnapshot", "reasoningEffort", "startedAt", "status", "taskId", "trigger", "workId") SELECT "baseCommit", "branchName", "command", "concurrencyMode", "contextTier", "copilotSessionId", "cpuTimeMs", "createdAt", "engine", "errorMessage", "executionPath", "exitCode", "finalCommit", "finalOutput", "finishedAt", "hostname", "id", "logPath", "model", "outputDir", "outputFormat", "peakMemoryMb", "pid", "promptSnapshot", "reasoningEffort", "startedAt", "status", "taskId", "trigger", "workId" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_taskId_idx" ON "Run"("taskId");
CREATE INDEX "Run_workId_createdAt_idx" ON "Run"("workId", "createdAt");
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");
CREATE INDEX "Run_resumedFromRunId_idx" ON "Run"("resumedFromRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TerminalLaunch_tokenHash_key" ON "TerminalLaunch"("tokenHash");

-- CreateIndex
CREATE INDEX "TerminalLaunch_runId_idx" ON "TerminalLaunch"("runId");

-- CreateIndex
CREATE INDEX "TerminalLaunch_status_expiresAt_idx" ON "TerminalLaunch"("status", "expiresAt");
