-- CreateTable
CREATE TABLE "Work" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourceRepoId" TEXT,
    "name" TEXT NOT NULL,
    "directoryPath" TEXT NOT NULL,
    "canonicalPath" TEXT NOT NULL,
    "promptFileName" TEXT NOT NULL DEFAULT 'PROMPT.md',
    "promptCache" TEXT NOT NULL DEFAULT '',
    "promptHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "defaultEngine" TEXT NOT NULL DEFAULT 'CLI',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Work_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Work_sourceRepoId_fkey" FOREIGN KEY ("sourceRepoId") REFERENCES "Repo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkPathShortcut" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkPathShortcut_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "workId" TEXT,
    "prompt" TEXT NOT NULL,
    "agent" TEXT,
    "model" TEXT,
    "fallbackModel" TEXT,
    "contextTier" TEXT,
    "reasoningEffort" TEXT,
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "outputFormat" TEXT NOT NULL DEFAULT 'text',
    "triggerType" TEXT NOT NULL,
    "cronExpression" TEXT,
    "webhookEvents" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useSafeBranch" BOOLEAN NOT NULL DEFAULT true,
    "waitForPreviousRuns" BOOLEAN NOT NULL DEFAULT false,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 1800,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("agent", "contextTier", "createdAt", "cronExpression", "enabled", "fallbackModel", "id", "model", "name", "outputFormat", "permissionMode", "prompt", "reasoningEffort", "repoId", "timeoutSeconds", "triggerType", "updatedAt", "useSafeBranch", "waitForPreviousRuns", "webhookEvents") SELECT "agent", "contextTier", "createdAt", "cronExpression", "enabled", "fallbackModel", "id", "model", "name", "outputFormat", "permissionMode", "prompt", "reasoningEffort", "repoId", "timeoutSeconds", "triggerType", "updatedAt", "useSafeBranch", "waitForPreviousRuns", "webhookEvents" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_repoId_idx" ON "Task"("repoId");
CREATE INDEX "Task_workId_idx" ON "Task"("workId");
CREATE INDEX "Task_triggerType_enabled_idx" ON "Task"("triggerType", "enabled");
CREATE INDEX "Task_repoId_triggerType_enabled_idx" ON "Task"("repoId", "triggerType", "enabled");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Work_userId_status_updatedAt_idx" ON "Work"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Work_sourceRepoId_idx" ON "Work"("sourceRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "Work_userId_canonicalPath_promptFileName_key" ON "Work"("userId", "canonicalPath", "promptFileName");

-- CreateIndex
CREATE INDEX "WorkPathShortcut_userId_position_idx" ON "WorkPathShortcut"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPathShortcut_userId_rootPath_key" ON "WorkPathShortcut"("userId", "rootPath");
