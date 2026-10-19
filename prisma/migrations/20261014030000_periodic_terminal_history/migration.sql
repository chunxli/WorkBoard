PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_TerminalLaunch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "launcherPid" INTEGER,
    "launchedAt" DATETIME,
    "completedAt" DATETIME,
    "inactiveSince" DATETIME,
    "historySize" INTEGER,
    "historyModifiedAt" DATETIME,
    "syncToken" TEXT,
    "syncOwnerPid" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalLaunch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_TerminalLaunch" ("id", "runId", "status", "launcherPid", "launchedAt", "completedAt", "errorMessage", "createdAt", "updatedAt")
SELECT "id", "runId", "status", "launcherPid", "launchedAt", "completedAt", "errorMessage", "createdAt", "updatedAt" FROM "TerminalLaunch";

DROP TABLE "TerminalLaunch";
ALTER TABLE "new_TerminalLaunch" RENAME TO "TerminalLaunch";
CREATE UNIQUE INDEX "TerminalLaunch_runId_key" ON "TerminalLaunch"("runId");
CREATE INDEX "TerminalLaunch_status_updatedAt_idx" ON "TerminalLaunch"("status", "updatedAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;