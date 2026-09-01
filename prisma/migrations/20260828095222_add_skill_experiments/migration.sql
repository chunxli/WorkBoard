-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invocationMode" TEXT NOT NULL DEFAULT 'EXPLICIT',
    "engine" TEXT NOT NULL DEFAULT 'CLI',
    "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "basePath" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Experiment_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "experimentId" TEXT NOT NULL,
    "skillName" TEXT,
    "skillSourcePath" TEXT,
    "skillHash" TEXT,
    "directoryPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COPYING',
    "skillInvoked" BOOLEAN,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "workId" TEXT,
    "experimentVariantId" TEXT,
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
    CONSTRAINT "Run_experimentVariantId_fkey" FOREIGN KEY ("experimentVariantId") REFERENCES "ExperimentVariant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Run_resumedFromRunId_fkey" FOREIGN KEY ("resumedFromRunId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("baseCommit", "branchName", "command", "concurrencyMode", "contextTier", "copilotSessionId", "cpuTimeMs", "createdAt", "engine", "errorMessage", "executionPath", "exitCode", "finalCommit", "finalOutput", "finishedAt", "hostname", "id", "logPath", "model", "outputDir", "outputFormat", "peakMemoryMb", "pid", "promptSnapshot", "reasoningEffort", "resumedFromRunId", "startedAt", "status", "taskId", "trigger", "workId") SELECT "baseCommit", "branchName", "command", "concurrencyMode", "contextTier", "copilotSessionId", "cpuTimeMs", "createdAt", "engine", "errorMessage", "executionPath", "exitCode", "finalCommit", "finalOutput", "finishedAt", "hostname", "id", "logPath", "model", "outputDir", "outputFormat", "peakMemoryMb", "pid", "promptSnapshot", "reasoningEffort", "resumedFromRunId", "startedAt", "status", "taskId", "trigger", "workId" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_taskId_idx" ON "Run"("taskId");
CREATE INDEX "Run_workId_createdAt_idx" ON "Run"("workId", "createdAt");
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");
CREATE INDEX "Run_resumedFromRunId_idx" ON "Run"("resumedFromRunId");
CREATE INDEX "Run_experimentVariantId_idx" ON "Run"("experimentVariantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Experiment_workId_createdAt_idx" ON "Experiment"("workId", "createdAt");

-- CreateIndex
CREATE INDEX "ExperimentVariant_experimentId_status_idx" ON "ExperimentVariant"("experimentId", "status");
