#!/usr/bin/env node

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { nextHostnameArgs, resolveRuntimeAuthMode } from "./auth-mode.mjs";

const action = process.argv[2]?.toLowerCase();
if (action !== "dev" && action !== "start") {
  console.error("Usage: node scripts/run-next.mjs <dev|start>");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const mode = resolveRuntimeAuthMode();
if (mode === "local") {
  console.log(
    "[Work Board] Login-free local mode: listening on 127.0.0.1 only.",
  );
}

const child = spawn(
  process.execPath,
  [nextBin, action, "-p", "3100", ...nextHostnameArgs()],
  { cwd: root, env: process.env, stdio: "inherit", windowsHide: false },
);

child.once("error", (error) => {
  console.error(`[Work Board] Failed to start Next.js: ${error.message}`);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
