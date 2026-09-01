import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";

export default async function DashboardPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");
  redirect("/work");
}

