import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { openDirectoryInVSCode } from "./local-vscode";

const cleanupPaths: string[] = [];

describe("local VS Code opener", () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it.skipIf(process.platform !== "win32")("opens a directory through the VS Code CLI", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workboard-vscode-"));
    cleanupPaths.push(directory);
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await openDirectoryInVSCode(directory);

    expect(spawn).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", "code.cmd", path.resolve(directory)],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    expect(child.unref).toHaveBeenCalledOnce();
    await rm(directory, { recursive: true, force: true });
    cleanupPaths.splice(cleanupPaths.indexOf(directory), 1);
  });
});
