/*
  Warnings:

  - A unique constraint covering the columns `[runId]` on the table `TerminalLaunch` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "TerminalLaunch_runId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "TerminalLaunch_runId_key" ON "TerminalLaunch"("runId");
