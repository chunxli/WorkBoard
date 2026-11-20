import type { Metadata } from "next";
import CaseIqDocumentation from "@/components/CaseIqDocumentation";
import { readCaseIqDocumentation } from "@/lib/caseiq-docs";

export const metadata: Metadata = { title: "CaseIQ Integration | Work Board" };

export default async function CaseIqDocsPage() {
  return <CaseIqDocumentation {...await readCaseIqDocumentation("integration")} />;
}
