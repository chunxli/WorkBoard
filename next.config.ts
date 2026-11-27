import type { NextConfig } from "next";
import { resolveNextDistDir } from "./scripts/next-output.mjs";

const nextConfig: NextConfig = {
  distDir: resolveNextDistDir(),
  serverExternalPackages: ["@github/copilot-sdk", "node-notifier"],
  outputFileTracingIncludes: {
    "*": [
      "./scripts/workboard-caseiq.ps1",
      "./scripts/caseiq-native-delegate.mjs",
      "./scripts/caseiq-auth-observer.mjs",
      "./scripts/native-bridge-protocol.mjs",
      "./scripts/native-mcp-permissions.mjs",
      "./scripts/native-shared-oauth.mjs",
      "./scripts/owned-process.mjs",
      "./scripts/private-runtime-directory.ps1",
      "./scripts/supportiq-mcp-bridge.mjs",
      "./scripts/workboard-resume.ps1",
      "./node_modules/zod/**/*",
      "./node_modules/json5/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "*": ["./data/**/*", "./.workboard/**/*", "./.env*", "./*.db*"],
  },
  experimental: {
    proxyClientMaxBodySize: 26 * 1024 * 1024,
  },
};

export default nextConfig;
