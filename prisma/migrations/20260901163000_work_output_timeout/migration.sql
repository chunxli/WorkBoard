-- AlterTable
ALTER TABLE "Work" ADD COLUMN "outputFormat" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "Work" ADD COLUMN "timeoutSeconds" INTEGER;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "timeoutSeconds" INTEGER;

-- AlterTable
ALTER TABLE "UserExecutionSettings" ADD COLUMN "workTimeoutSeconds" INTEGER;