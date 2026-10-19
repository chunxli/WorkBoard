CREATE TABLE "WorkSteeringMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "deliveryState" TEXT NOT NULL DEFAULT 'SUBMITTING',
    "transportMessageId" TEXT,
    "promptSynced" BOOLEAN NOT NULL DEFAULT false,
    "promptError" TEXT,
    "artifactSynced" BOOLEAN NOT NULL DEFAULT false,
    "artifactError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "observedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkSteeringMessage_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkSteeringMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkSteeringMessage_runId_requestId_key" ON "WorkSteeringMessage"("runId", "requestId");
CREATE INDEX "WorkSteeringMessage_workId_createdAt_idx" ON "WorkSteeringMessage"("workId", "createdAt");
CREATE INDEX "WorkSteeringMessage_runId_createdAt_idx" ON "WorkSteeringMessage"("runId", "createdAt");
CREATE INDEX "WorkSteeringMessage_sessionId_createdAt_idx" ON "WorkSteeringMessage"("sessionId", "createdAt");
