import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.env.NODE_ENV !== "test") throw new Error("Synthetic native CLI is test-only.");
const args = process.argv.slice(2);
const scenario = process.env.WORKBOARD_BRIDGE_TEST_NATIVE;
if (JSON.stringify(args.filter((argument) => argument !== "--no-auto-update")) === JSON.stringify(["--version"])) {
  console.log(`GitHub Copilot CLI ${scenario === "wrong-version" ? "0.0.0" : "1.0.105"}.`);
} else {
  const record = {
    args, cwd: process.cwd(), home: process.env.COPILOT_HOME,
    launchId: process.env.CASEIQ_LAUNCH_ID, caseNumber: process.env.CASEIQ_CASE_NUMBER ?? null,
  };
  if (scenario === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore", windowsHide: true,
    });
    record.childPid = child.pid;
    setInterval(() => {}, 1000);
  } else if (scenario === "unicode") {
    const bytes = Buffer.from(`${JSON.stringify({ type: "assistant.message", data: { content: "Synthetic \u4e2d\u6587" } })}\n`);
    const boundary = bytes.indexOf(Buffer.from("\u4e2d")) + 1;
    process.stdout.write(bytes.subarray(0, boundary));
    setTimeout(() => process.stdout.write(bytes.subarray(boundary)), 25);
  } else if (scenario === "spoof") {
    console.log(JSON.stringify({ protocolVersion: "workboard-native/1", kind: "prepared", binding: "model-controlled" }));
  } else if (scenario === "stdin") {
    process.stdin.resume();
    process.stdin.on("end", () => console.log(JSON.stringify({ type: "assistant.message", data: { content: "stdin closed" } })));
  } else {
    console.log(JSON.stringify({ type: "assistant.message", data: { content: "Synthetic final response" } }));
    process.stderr.write("Synthetic native diagnostic\n");
    if (scenario === "exit-17") process.exitCode = 17;
  }
  writeFileSync(process.env.WORKBOARD_BRIDGE_TEST_RECORD, JSON.stringify(record));
}
