-- AlterTable
ALTER TABLE "Work" ADD COLUMN "agent" TEXT;
ALTER TABLE "Work" ADD COLUMN "model" TEXT;
ALTER TABLE "Work" ADD COLUMN "fallbackModel" TEXT;
ALTER TABLE "Work" ADD COLUMN "contextTier" TEXT;
ALTER TABLE "Work" ADD COLUMN "reasoningEffort" TEXT;
ALTER TABLE "Work" ADD COLUMN "permissionMode" TEXT NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "agent" TEXT;
ALTER TABLE "Run" ADD COLUMN "fallbackModel" TEXT;
ALTER TABLE "Run" ADD COLUMN "permissionMode" TEXT;
