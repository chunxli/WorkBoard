import { NextRequest, NextResponse } from "next/server";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isGitRepo, getCurrentBranch } from "@/lib/git-safety";
import { inferResourceName, inferResourceSourceType } from "@/lib/resource-input";

/** Asks the remote for its default branch without cloning, so users don't have to guess/type it. */
function detectRemoteDefaultBranch(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", "--symref", url, "HEAD"], { windowsHide: true });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, 6000);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const match = stdout.match(/refs\/heads\/(\S+)\s+HEAD/);
      resolve(match ? match[1] : null);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort auto-detection for the Add Repo form: infers whether the input is a local path or a
 * git URL, suggests a name, and tries to find the default branch so the user doesn't have to know it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const location = typeof body?.location === "string" ? body.location.trim() : "";
  if (!location) {
    return NextResponse.json({ error: "location is required" }, { status: 400 });
  }

  const sourceType = inferResourceSourceType(location);
  const name = inferResourceName(location);

  if (sourceType === "GIT_URL") {
    const defaultBranch = (await detectRemoteDefaultBranch(location)) ?? "main";
    return NextResponse.json({ sourceType, name, defaultBranch });
  }

  const exists = await pathExists(location);
  if (!exists) {
    return NextResponse.json({ sourceType, name, defaultBranch: "main", exists: false });
  }

  const gitRepo = await isGitRepo(location);
  const defaultBranch = gitRepo ? (await getCurrentBranch(location)) || "main" : "main";
  return NextResponse.json({ sourceType, name, defaultBranch, exists: true, isGitRepo: gitRepo });
}
