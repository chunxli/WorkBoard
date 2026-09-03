#!/usr/bin/env node
// Quick-start: ensures the Prisma client + SQLite schema are up to date, then
// launches the single Next.js process that serves the frontend, API routes,
// and the cron scheduler (this project has no separate backend server).
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";

// All commands below are static (no interpolated/user-controlled input), so
// running them as a single shell string is safe and avoids Node's shell-array
// deprecation warning (DEP0190).
function run(command) {
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("[quickstart] Generating Prisma client...");
run("npx prisma generate");

console.log("[quickstart] Applying pending migrations...");
run("npx prisma migrate deploy");

console.log("[quickstart] Starting Next.js (frontend + API + scheduler)...");
const dev = spawn(
  process.execPath,
  [path.join(import.meta.dirname, "run-next.mjs"), "dev"],
  { stdio: "inherit" },
);
dev.on("exit", (code) => process.exit(code ?? 0));
