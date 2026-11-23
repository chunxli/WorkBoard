CREATE TABLE "WorkSessionPair" (
    "workId" TEXT NOT NULL PRIMARY KEY,
    "cliSessionId" TEXT NOT NULL,
    "caseIqSessionId" TEXT NOT NULL,
    CONSTRAINT "WorkSessionPair_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkSessionPair_distinct_sessions" CHECK ("cliSessionId" <> "caseIqSessionId")
);

CREATE UNIQUE INDEX "WorkSessionPair_cliSessionId_key" ON "WorkSessionPair"("cliSessionId");
CREATE UNIQUE INDEX "WorkSessionPair_caseIqSessionId_key" ON "WorkSessionPair"("caseIqSessionId");
