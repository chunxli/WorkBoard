-- AlterTable
ALTER TABLE "Work" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Work_userId_status_position_idx" ON "Work"("userId", "status", "position");