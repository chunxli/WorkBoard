import { appendFileSync, readFileSync } from "node:fs";

if (process.env.NODE_ENV !== "test") throw new Error("Synthetic authentication CLI is test-only.");
const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
const args = process.argv.slice(3);
if (JSON.stringify(args.filter((argument) => argument !== "--no-auto-update")) === JSON.stringify(["--version"])) {
  console.log("GitHub Copilot CLI 1.0.105.");
} else {
  if (args.some((argument) => argument === "-p" || argument === "-i" || /^--allow-all/.test(argument))) {
    throw new Error("Authentication must not receive a task Prompt or unrestricted permissions.");
  }
  appendFileSync(configuration.record, `${JSON.stringify({
    args, home: process.env.COPILOT_HOME, pid: process.pid, prompt: null,
  })}\n`);
}
