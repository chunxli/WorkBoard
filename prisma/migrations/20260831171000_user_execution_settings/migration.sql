-- CreateTable
CREATE TABLE "UserExecutionSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "defaultEngine" TEXT NOT NULL DEFAULT 'CLI',
    "agent" TEXT,
    "model" TEXT,
    "fallbackModel" TEXT,
    "contextTier" TEXT,
    "reasoningEffort" TEXT,
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "outputFormat" TEXT NOT NULL DEFAULT 'text',
    "automationTimeoutSeconds" INTEGER NOT NULL DEFAULT 1800,
    "useSafeBranch" BOOLEAN NOT NULL DEFAULT true,
    "waitForPreviousRuns" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserExecutionSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserExecutionSettings_userId_key" ON "UserExecutionSettings"("userId");
