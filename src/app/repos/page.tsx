import { redirect } from "next/navigation";

export default async function ReposPage() {
  redirect("/tasks/new");
}
