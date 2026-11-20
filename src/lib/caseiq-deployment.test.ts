import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("CaseIQ deployment boundaries", () => {
  it("includes native bridge assets for route and non-route entrypoints", () => {
    expect(nextConfig.outputFileTracingIncludes?.["*"]).toEqual(expect.arrayContaining([
      "./scripts/workboard-caseiq.ps1",
      "./scripts/caseiq-native-delegate.mjs",
      "./scripts/native-bridge-protocol.mjs",
      "./scripts/native-mcp-permissions.mjs",
      "./scripts/native-shared-oauth.mjs",
      "./scripts/owned-process.mjs",
      "./scripts/private-runtime-directory.ps1",
      "./scripts/workboard-resume.ps1",
      "./node_modules/zod/**/*",
    ]));
  });

  it("defines privacy exclusions without requiring slash-prefixed route names", () => {
    expect(nextConfig.outputFileTracingExcludes?.["*"]).toEqual(expect.arrayContaining([
      "./data/**/*", "./.workboard/**/*", "./.env*", "./*.db*",
    ]));
  });
});
