import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute, realPath } = vi.hoisted(() => ({ execute: vi.fn(), realPath: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("node:fs/promises", () => ({ realpath: realPath }));
import { sendWindowsSystemNotification } from "./windows-system-notifier";

const sample = { title: "Work completed", message: '测试 "work" & result', details: "2m · 2M tokens", url: "http://localhost:3100/work/work-1" };
let payloads: string[];
beforeEach(() => {
  vi.resetAllMocks();
  payloads = [];
  realPath.mockResolvedValue("C:\\Work Board\\application");
  execute.mockImplementation((_file, _args, _options, callback) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    Object.assign(child, { stdin });
    let body = "";
    stdin.on("data", (chunk) => { body += chunk.toString(); });
    stdin.on("finish", () => {
      payloads.push(body);
      const input = JSON.parse(body);
      callback(null, JSON.stringify({ submitted: true, appId: input.appId, tag: "0123456789abcdef", icon: path.join(input.root, "public", "workboard-notification.png") }), "");
    });
    return child;
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("native Windows notification submission", () => {
  it("uses a hidden bounded native process with structured stdin, not interpolated commands", async () => {
    vi.stubEnv("AUTH_SECRET", "must-not-reach-helper");
    vi.stubEnv("GH_TOKEN", "must-not-reach-helper");
    await sendWindowsSystemNotification(sample);
    const [file, args, options] = execute.mock.calls[0];
    expect(file).toContain("powershell.exe");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-File");
    expect(args.join(" ")).not.toContain(sample.message);
    expect(options).toMatchObject({ windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
    expect(options.env.AUTH_SECRET).toBeUndefined();
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(JSON.parse(payloads[0])).toMatchObject({
      ...sample, root: "C:\\Work Board\\application", appId: expect.stringMatching(/^WorkBoard\.Desktop\.[a-f0-9]{16}$/),
    });
  });

  it("keeps concurrent URLs and content separate without a global click listener", async () => {
    await Promise.all([sendWindowsSystemNotification(sample), sendWindowsSystemNotification({ ...sample, url: "http://localhost:3100/work/work-2", message: "Other Work" })]);
    expect(payloads.map((body) => JSON.parse(body).url).sort()).toEqual(["http://localhost:3100/work/work-1", "http://localhost:3100/work/work-2"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects native exit errors without treating timeout or missing output as success", async () => {
    execute.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("process failed"), "", "Notifications are disabled by policy"));
      return { stdin: new PassThrough() };
    });

    await expect(sendWindowsSystemNotification(sample)).rejects.toThrow("disabled by policy");
  });

  it("rejects a killed/timed-out helper without a successful submission acknowledgement", async () => {
    execute.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error("Helper timed out"), { killed: true, signal: "SIGTERM" }), "", ""));
      return { stdin: new PassThrough() };
    });
    await expect(sendWindowsSystemNotification(sample)).rejects.toThrow("timed out");
  });

  it("rejects a different identity even when the helper says submitted", async () => {
    execute.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, JSON.stringify({
        submitted: true, appId: "WorkBoard.Desktop.another", tag: "0123456789abcdef", icon: "icon.png",
      }), ""));
      return { stdin: new PassThrough() };
    });
    await expect(sendWindowsSystemNotification(sample)).rejects.toThrow("invalid submission result");
  });

  it.each(["", "not json", '{"submitted":false}', '{"submitted":true}'])("requires a valid native submission acknowledgement for %s", async (stdout) => {
    execute.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, stdout, ""));
      return { stdin: new PassThrough() };
    });
    await expect(sendWindowsSystemNotification(sample)).rejects.toThrow(/did not confirm|invalid submission/);
  });
});
