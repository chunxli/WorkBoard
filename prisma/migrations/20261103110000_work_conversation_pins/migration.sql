CREATE TABLE "WorkConversationPin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventOffset" REAL NOT NULL,
    "line" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "timestamp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkConversationPin_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorkConversationPin_workId_sessionId_createdAt_idx" ON "WorkConversationPin"("workId", "sessionId", "createdAt");
CREATE UNIQUE INDEX "WorkConversationPin_workId_sessionId_eventId_line_key" ON "WorkConversationPin"("workId", "sessionId", "eventId", "line");
