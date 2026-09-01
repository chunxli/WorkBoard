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
    CONSTRAINT "Run_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("baseCommit", "branchName", "command", "contextTier", "cpuTimeMs", "createdAt", "errorMessage", "exitCode", "finalCommit", "finishedAt", "hostname", "id", "logPath", "model", "outputFormat", "peakMemoryMb", "pid", "reasoningEffort", "startedAt", "status", "taskId", "trigger") SELECT "baseCommit", "branchName", "command", "contextTier", "cpuTimeMs", "createdAt", "errorMessage", "exitCode", "finalCommit", "finishedAt", "hostname", "id", "logPath", "model", "outputFormat", "peakMemoryMb", "pid", "reasoningEffort", "startedAt", "status", "taskId", "trigger" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_taskId_idx" ON "Run"("taskId");
CREATE INDEX "Run_workId_createdAt_idx" ON "Run"("workId", "createdAt");
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
