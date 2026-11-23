import type { Metadata } from "next";
import CaseIqDocumentation from "@/components/CaseIqDocumentation";
import { readCaseIqDocumentation } from "@/lib/caseiq-docs";

export const metadata: Metadata = { title: "CaseIQ Native Bridge | Work Board" };

export default async function CaseIqBridgeDocsPage() {
  return <CaseIqDocumentation {...await readCaseIqDocumentation("bridge")} />;
}
