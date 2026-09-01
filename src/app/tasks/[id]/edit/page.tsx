import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import EditTaskForm from "@/components/EditTaskForm";
import PageHeader from "@/components/PageHeader";

export default async function EditTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { id } = await params;
  const [task, repos] = await Promise.all([
    prisma.task.findFirst({ where: { id, repo: { userId } } }),
    prisma.repo.findMany({ where: { userId }, orderBy: { name: "asc" } }),
  ]);
  if (!task) notFound();

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Automation setup" title="Edit automation" />
      <EditTaskForm task={task} repos={repos} />
    </div>
  );
}
