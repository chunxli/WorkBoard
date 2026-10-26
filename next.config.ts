import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@github/copilot-sdk", "node-notifier"],
  experimental: {
    proxyClientMaxBodySize: 26 * 1024 * 1024,
  },
};

export default nextConfig;
