import { describe, expect, it } from "vitest";
import {
  CASEIQ_MAX_PACKS, caseIqLaunchSchema, caseIqPendingTerminalKey,
  classifyCaseIqTerminalResponse, clearCaseIqPendingTerminal,
  readCaseIqPendingTerminal, rememberCaseIqPendingTerminal,
} from "./caseiq-options";

const first = { requestId: "12345678-1234-4234-8234-123456789abc", action: "new" as const };
const second = { requestId: "12345678-1234-4234-8234-123456789abd", action: "resume" as const };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("CaseIQ browser request confirmation", () => {
  it.each([200, 202])("accepts only a valid native receipt on HTTP %s", (status) => {
    expect(classifyCaseIqTerminalResponse(status, '{"runId":"caseiq-run","launcherPid":null}'))
      .toEqual({ state: "accepted", receipt: { runId: "caseiq-run", launcherPid: null } });
  });

  it.each([400, 401, 403, 404, 409, 422, 429])("distinguishes an explicit HTTP %s rejection", (status) => {
    expect(classifyCaseIqTerminalResponse(status, '{"error":"Not accepted"}'))
      .toEqual({ state: "rejected", message: "Not accepted" });
  });

  it.each([200, 202, 204, 408, 500, 502, 503])("keeps a missing native receipt unconfirmed on HTTP %s", (status) => {
    expect(classifyCaseIqTerminalResponse(status, '{"error":"No receipt"}').state).toBe("unconfirmed");
    expect(classifyCaseIqTerminalResponse(status, "<html>Connection lost</html>").state).toBe("unconfirmed");
  });

  it("does not mistake malformed or extra receipt fields for acceptance", () => {
    expect(classifyCaseIqTerminalResponse(200, '{"runId":"run","launcherPid":-1}').state).toBe("unconfirmed");
    expect(classifyCaseIqTerminalResponse(200, '{"runId":"run","launcherPid":1,"home":"private"}').state).toBe("unconfirmed");
    expect(classifyCaseIqTerminalResponse(403, "<html>Forbidden</html>").state).toBe("rejected");
  });

  it("keeps a pending request across remounts without storing prompt, case or private paths", () => {
    const storage = memoryStorage();
    rememberCaseIqPendingTerminal(storage, "work", first);
    expect(readCaseIqPendingTerminal(storage, "work")).toEqual(first);
    expect(storage.getItem(caseIqPendingTerminalKey("work"))).toBe(JSON.stringify(first));
    expect(() => rememberCaseIqPendingTerminal(storage, "work", second)).toThrow("unconfirmed");
    expect(clearCaseIqPendingTerminal(storage, "work", first.requestId)).toBe(true);
    expect(readCaseIqPendingTerminal(storage, "work")).toBeNull();
  });

  it("does not let an old completion clear a newer or another Work's pending request", () => {
    const storage = memoryStorage();
    rememberCaseIqPendingTerminal(storage, "work", second);
    rememberCaseIqPendingTerminal(storage, "other-work", first);
    expect(clearCaseIqPendingTerminal(storage, "work", first.requestId)).toBe(false);
    expect(readCaseIqPendingTerminal(storage, "work")).toEqual(second);
    expect(clearCaseIqPendingTerminal(storage, "other-work", first.requestId)).toBe(true);
    expect(readCaseIqPendingTerminal(storage, "work")).toEqual(second);
  });

  it("surfaces invalid or unavailable browser storage instead of silently enabling another launch", () => {
    const storage = memoryStorage();
    storage.setItem(caseIqPendingTerminalKey("work"), "{invalid");
    expect(() => readCaseIqPendingTerminal(storage, "work")).toThrow();
    expect(() => rememberCaseIqPendingTerminal(storage, "work", first)).toThrow();
    const inaccessible = { ...storage, getItem: () => { throw new Error("Storage denied"); } };
    expect(() => rememberCaseIqPendingTerminal(inaccessible, "work", first)).toThrow("Storage denied");
    const unwritable = { ...memoryStorage(), setItem: () => { throw new Error("Storage write denied"); } };
    expect(() => rememberCaseIqPendingTerminal(unwritable, "work", first)).toThrow("Storage write denied");
    const uncleared = memoryStorage();
    rememberCaseIqPendingTerminal(uncleared, "work", first);
    expect(() => clearCaseIqPendingTerminal({
      ...uncleared, removeItem: () => { throw new Error("Storage cleanup denied"); },
    }, "work", first.requestId)).toThrow("Storage cleanup denied");
  });

  it("enforces the actual 32-pack boundary and safe defaults", () => {
    const packs = Array.from({ length: CASEIQ_MAX_PACKS }, (_, index) => `pack-${index}`);
    expect(caseIqLaunchSchema.parse({ packs })).toEqual({ packs, caseNumber: null, sendPrompt: false });
    expect(caseIqLaunchSchema.safeParse({ packs: [...packs, "one-too-many"] }).success).toBe(false);
  });
});
