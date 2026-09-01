import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import CreateTaskForm from "@/components/CreateTaskForm";
import PageHeader from "@/components/PageHeader";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ resource?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const [repos, executionDefaults] = await Promise.all([
    prisma.repo.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    getUserExecutionDefaults(userId),
  ]);
  const { resource } = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Automation setup" title="New automation" />
      <CreateTaskForm
        repos={repos}
        initialResourceId={resource}
        executionDefaults={executionDefaults}
      />
    </div>
  );
}
