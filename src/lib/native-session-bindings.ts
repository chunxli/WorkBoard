import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";
import { nativeBindingCompatibilityKey } from "@/lib/native-session-identity";
import { nativeOAuthStorageSchema } from "../../scripts/native-bridge-protocol.mjs";

const absolutePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes("\0"));

export const nativeSessionBindingSchema = z.object({
  bindingVersion: z.literal(1),
  providerId: z.literal("caseiq"),
  sessionId: z.uuid(),
  userId: z.string().min(1),
  workId: z.string().min(1),
  hostname: z.string().min(1),
  home: absolutePath.nullable(),
  finalHome: absolutePath.optional(),
  launcherPath: absolutePath,
  launcherSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  nativeExecutable: absolutePath,
  nativeVersion: z.string(),
  workingDirectory: absolutePath,
  packs: z.array(z.string()),
  caseNumber: z.string().nullable(),
  oauthStorage: nativeOAuthStorageSchema.optional(),
}).strict().refine((binding) => !binding.finalHome || binding.home !== null &&
  path.relative(path.dirname(binding.home), path.dirname(binding.finalHome)) === "" &&
  path.basename(binding.finalHome).toLowerCase() === binding.sessionId.toLowerCase(),
  "The final native home must be the same session's sibling directory.");

export type NativeSessionBinding = z.infer<typeof nativeSessionBindingSchema>;

export function nativeSessionBindingHome(binding: NativeSessionBinding): string | null {
  return binding.finalHome ?? binding.home;
}

function bindingPath(sessionId: string): string {
  if (!z.uuid().safeParse(sessionId).success) throw new Error("Invalid native session ID.");
  return path.join(getCaseIqStateRoot(), "bindings", `${sessionId}.json`);
}

export function readNativeSessionBindingSync(sessionId: string): NativeSessionBinding | null {
  let content: string;
  try { content = readFileSync(/* turbopackIgnore: true */ bindingPath(sessionId), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const binding = nativeSessionBindingSchema.parse(JSON.parse(content));
  if (binding.sessionId !== sessionId || binding.hostname !== hostname()) {
    throw new Error("Native session binding belongs to a different session or host.");
  }
  return binding;
}

export function boundNativeSessionHome(sessionId: string): string | undefined {
  const binding = readNativeSessionBindingSync(sessionId);
  if (!binding) return undefined;
  const home = nativeSessionBindingHome(binding);
  if (home === null) {
    const error = new Error("Waiting for CaseIQ to bind its native session.");
    Object.assign(error, { code: "ENOENT" });
    throw error;
  }
  return home;
}

export async function saveNativeSessionBinding(value: NativeSessionBinding): Promise<void> {
  const binding = nativeSessionBindingSchema.parse(value);
  const file = bindingPath(binding.sessionId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let prior: NativeSessionBinding | null = null;
  try { prior = nativeSessionBindingSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (prior && (
    prior.userId !== binding.userId || prior.workId !== binding.workId ||
    prior.hostname !== binding.hostname || nativeBindingCompatibilityKey(prior) !== nativeBindingCompatibilityKey(binding) ||
    prior.workingDirectory !== binding.workingDirectory ||
    prior.home !== null && prior.home !== binding.home ||
    prior.finalHome !== undefined && prior.finalHome !== binding.finalHome ||
    JSON.stringify(prior.packs) !== JSON.stringify(binding.packs) || prior.caseNumber !== binding.caseNumber
  )) throw new Error("Refusing to replace a different native session binding.");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}
