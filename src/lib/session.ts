import { headers } from "next/headers";
import { auth } from "@/auth";
import { authMode, isLoopbackHostname } from "@/lib/auth-mode";
import { prisma } from "@/lib/prisma";

export const LOCAL_USER_ID = "workboard-local-user";

const globalForLocalUser = globalThis as unknown as {
  workBoardLocalUserPromise?: Promise<string>;
};

async function getLocalUserId(): Promise<string> {
  const existing = globalForLocalUser.workBoardLocalUserPromise;
  if (existing) return existing;

  const pending = prisma.user
    .upsert({
      where: { id: LOCAL_USER_ID },
      create: { id: LOCAL_USER_ID, name: "Local User" },
      update: {},
      select: { id: true },
    })
    .then((user) => user.id)
    .catch((error) => {
      delete globalForLocalUser.workBoardLocalUserPromise;
      throw error;
    });
  globalForLocalUser.workBoardLocalUserPromise = pending;
  return pending;
}

/** Resolves the signed-in user's id for scoping DB queries (already gated by proxy.ts, checked again defensively). */
export async function getSessionUserId(): Promise<string | null> {
  if (authMode === "local") {
    const requestHeaders = await headers();
    if (!isLoopbackHostname(requestHeaders.get("host"))) return null;
    return getLocalUserId();
  }
  const session = await auth();
  return session?.user?.id ?? null;
}
