ALTER TABLE "Run" ADD COLUMN "notificationClaimedAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "notificationSentAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "notificationSuppressedAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "notificationError" TEXT;

ALTER TABLE "Experiment" ADD COLUMN "finishedAt" DATETIME;
ALTER TABLE "Experiment" ADD COLUMN "notificationClaimedAt" DATETIME;
ALTER TABLE "Experiment" ADD COLUMN "notificationSentAt" DATETIME;
ALTER TABLE "Experiment" ADD COLUMN "notificationSuppressedAt" DATETIME;
ALTER TABLE "Experiment" ADD COLUMN "notificationError" TEXT;

ALTER TABLE "UserExecutionSettings" ADD COLUMN "systemNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Existing terminal records predate OS notifications and must never generate an upgrade backlog.
UPDATE "Run"
SET "notificationClaimedAt" = COALESCE("finishedAt", "createdAt"),
    "notificationSuppressedAt" = COALESCE("finishedAt", "createdAt")
WHERE "status" IN ('SUCCESS', 'FAILED', 'TIMED_OUT', 'CANCELLED');

UPDATE "Experiment"
SET "finishedAt" = COALESCE("updatedAt", "createdAt"),
    "notificationClaimedAt" = COALESCE("updatedAt", "createdAt"),
    "notificationSuppressedAt" = COALESCE("updatedAt", "createdAt")
WHERE "status" IN ('COMPLETED', 'FAILED');

CREATE INDEX "Run_notificationClaimedAt_finishedAt_idx"
ON "Run"("notificationClaimedAt", "finishedAt");
CREATE INDEX "Experiment_notificationClaimedAt_finishedAt_idx"
ON "Experiment"("notificationClaimedAt", "finishedAt");
