import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { caseIqMcpConfigurationHref } from "@/lib/caseiq-options";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  workId: z.string().min(1).max(128).optional(),
  runId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
});
export default async function McpPage({ searchParams }: {
  searchParams: Promise<{ workId?: string; runId?: string; sessionId?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");
  const parsed = querySchema.safeParse(await searchParams);
  if (!parsed.success) notFound();
  const input = parsed.data;
  if (input.runId) {
    const run = await prisma.run.findFirst({
      where: {
        id: input.runId, engine: "CASEIQ", providerId: "caseiq", work: { userId },
        ...(input.workId ? { workId: input.workId } : {}),
        ...(input.sessionId ? { copilotSessionId: input.sessionId } : {}),
      },
      select: { workId: true, copilotSessionId: true },
    });
    if (!run?.workId || !run.copilotSessionId) notFound();
    redirect(caseIqMcpConfigurationHref(run.workId, run.copilotSessionId));
  }
  redirect(input.workId ? caseIqMcpConfigurationHref(input.workId, input.sessionId) : "/work");
}
