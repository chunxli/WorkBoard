import { describe, expect, it, vi } from "vitest";
import { CaseIqIntegrationError } from "./caseiq-errors";

vi.mock("@/lib/prisma", () => { throw new Error("Read-only installation must not load Prisma."); });
vi.mock("@/lib/native-session-bindings", () => { throw new Error("Read-only installation must not load private session storage."); });
vi.mock("@/lib/caseiq-integration", () => { throw new Error("Read-only installation must not load the native lifecycle coordinator."); });

describe("CaseIQ responsibility boundaries", () => {
  it("loads the read-only installation API without database, private binding or lifecycle dependencies", async () => {
    const installation = await import("./caseiq-installation");
    expect(installation.getCaseIqStatus).toBeTypeOf("function");
    expect(installation.getCaseIqInstallation).toBeTypeOf("function");
    expect(installation.readCaseIqPackCatalog).toBeTypeOf("function");
    expect(installation.readCaseIqRegistration).toBeTypeOf("function");
    expect(installation).not.toHaveProperty("prepareCaseIqTerminal");
    expect(installation).not.toHaveProperty("acceptCaseIqPreparation");
  });

  it("preserves one shared error identity and explicit HTTP status across installation callers", async () => {
    const installation = await import("./caseiq-installation");
    expect(() => installation.assertCaseIqCheckout("invalid-revision")).toThrow(CaseIqIntegrationError);
    expect(new CaseIqIntegrationError("Not allowed", 403)).toMatchObject({
      name: "CaseIqIntegrationError", message: "Not allowed", status: 403,
    });
  });
});
