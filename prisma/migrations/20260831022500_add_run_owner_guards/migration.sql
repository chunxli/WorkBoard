CREATE TRIGGER "Run_owner_insert_guard"
BEFORE INSERT ON "Run"
FOR EACH ROW
WHEN NEW."taskId" IS NULL AND NEW."workId" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Run must belong to a Work or Automation');
END;

CREATE TRIGGER "Run_owner_update_guard"
BEFORE UPDATE OF "taskId", "workId" ON "Run"
FOR EACH ROW
WHEN NEW."taskId" IS NULL AND NEW."workId" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Run must belong to a Work or Automation');
END;
