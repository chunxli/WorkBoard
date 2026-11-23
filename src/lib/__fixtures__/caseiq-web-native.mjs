import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.NODE_ENV !== "test") throw new Error("Synthetic CaseIQ native CLI is test-only.");
const [configurationFile, ...args] = process.argv.slice(2);
if (JSON.stringify(args.filter((argument) => argument !== "--no-auto-update")) === JSON.stringify(["--version"])) {
  const config = JSON.parse(readFileSync(configurationFile, "utf8"));
  console.log(`GitHub Copilot CLI ${config.nativeVersion ?? "1.0.105"}.`);
} else {
  const config = JSON.parse(readFileSync(configurationFile, "utf8"));
  const value = (name) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const position = args.indexOf(name);
    return position < 0 ? null : args[position + 1];
  };
  const sessionId = value("--session-id") ?? value("--resume");
  const prompt = value("-p");
  const directory = path.join(process.env.COPILOT_HOME, "session-state", sessionId);
  mkdirSync(directory, { recursive: true });
  let attempts = [];
  try { attempts = readFileSync(config.record, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  appendFileSync(config.record, `${JSON.stringify({
    args, prompt, sessionId, resumed: value("--resume") !== null, pid: process.pid,
    cwd: process.cwd(), home: process.env.COPILOT_HOME,
    instructions: process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? null,
  })}\n`);
  const eventLine = (type, data) => {
    const event = { id: `${attempts.length}-${type}`, type, timestamp: new Date().toISOString(), data };
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(path.join(directory, "events.jsonl"), line);
    return line;
  };
  const emit = (type, data) => { process.stdout.write(eventLine(type, data)); };
  if (config.mode === "model-fallback" && value("--model") === "missing-model") {
    process.stderr.write('Error: Model "missing-model" from --model flag is not available.\n');
    process.exitCode = 1;
  } else {
    emit("user.message", { content: prompt });
    if (config.mode === "split-output") {
      const bytes = Buffer.from(eventLine("assistant.message", {
        content: "Synthetic split \u4e2d\u6587", privateLocation: config.privatePath,
      }));
      const encodedPath = Buffer.from(JSON.stringify(config.privatePath).slice(1, -1));
      const boundaries = [8, bytes.indexOf(Buffer.from("\u4e2d")) + 1, bytes.indexOf(encodedPath) + 12, bytes.length];
      const diagnostic = `Synthetic split diagnostic at ${config.privatePath.toUpperCase()}`;
      await Promise.all([
        (async () => {
          let start = 0;
          for (const end of boundaries) {
            process.stdout.write(bytes.subarray(start, end));
            start = end;
            await sleep(80);
          }
        })(),
        (async () => {
          const boundary = diagnostic.indexOf(config.privatePath.toUpperCase()) + 12;
          process.stderr.write(diagnostic.slice(0, boundary));
          await sleep(120);
          process.stderr.write(diagnostic.slice(boundary));
        })(),
      ]);
      emit("session.task_complete", {});
    } else if (config.mode === "wait" || config.mode === "wait-output" || config.mode === "rename-wait") {
      emit("tool.execution_start", { toolCallId: "synthetic-tool", toolName: "synthetic-wait" });
      setInterval(() => {
        if (config.mode === "wait-output" && existsSync(config.outputReady)) process.stdout.write("Synthetic live output\n");
      }, config.mode === "wait-output" ? 100 : 1000);
    } else if (config.mode === "incomplete" || config.mode === "incomplete-once" && attempts.length === 0) {
      emit("tool.execution_start", { toolCallId: "synthetic-tool", toolName: "synthetic-unfinished" });
    } else {
      if (config.mode === "incomplete-once") emit("tool.execution_complete", { toolCallId: "synthetic-tool" });
      emit("assistant.message", { content: `Synthetic CaseIQ response: ${prompt}` });
      emit("session.task_complete", {});
      if (config.mode === "exit-7") process.exitCode = 7;
    }
  }
}
