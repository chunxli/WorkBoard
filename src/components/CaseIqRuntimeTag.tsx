export default function CaseIqRuntimeTag({ title = "Runtime: CaseIQ" }: { title?: string }) {
  return <span data-runtime="caseiq" className="caseiq-runtime-tag" title={title}>CaseIQ</span>;
}
