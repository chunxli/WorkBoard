import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { reorderWorksSchema } from "@/lib/validation";
import { validateCompleteWorkOrder } from "@/lib/work-order";

export async function PUT(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = reorderWorksSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const currentWorks = await prisma.work.findMany({
    where: { userId, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  const validationError = validateCompleteWorkOrder(
    currentWorks.map((work) => work.id),
    parsed.data.workIds
  );
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 409 });
  }

  await prisma.$transaction(
    parsed.data.workIds.map((id, position) =>
      prisma.$executeRaw`
        UPDATE "Work"
        SET "position" = ${position}
        WHERE "id" = ${id} AND "userId" = ${userId} AND "status" != 'ARCHIVED'
      `
    )
  );
  return NextResponse.json({ reordered: parsed.data.workIds.length });
}