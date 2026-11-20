import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import MarkdownResult from "@/components/MarkdownResult";
import { caseIqDocumentation, caseIqDocumentationHref, type CaseIqDocumentId } from "@/lib/caseiq-docs";

export default function CaseIqDocumentation({
  document, content,
}: {
  document: (typeof caseIqDocumentation)[CaseIqDocumentId];
  content: string;
}) {
  return <div id="docs-top" className="scroll-mt-48 space-y-6 lg:scroll-mt-24">
    <PageHeader eyebrow="CaseIQ runtime reference" title={document.title}>
      <Link href="/docs#caseiq-guides" className="ui-secondary-button">All documentation</Link>
    </PageHeader>
    <div className="space-y-3">
      <p lang="zh-CN" className="text-sm text-neutral-300">{document.zh}</p>
      <p lang="en" className="text-xs text-neutral-500">{document.en}</p>
      <nav aria-label="CaseIQ documentation" className="flex flex-wrap gap-2">
        {Object.values(caseIqDocumentation).map((item) => <Link key={item.href} href={item.href}
          aria-current={item.href === document.href ? "page" : undefined} className="ui-secondary-button text-xs">{item.title}</Link>)}
      </nav>
      <p className="text-xs text-amber-300">Runtime → CaseIQ · Web Prompt and Follow Up · Original launcher · No SDK session control</p>
      <p lang="zh-CN" className="text-xs text-neutral-500">网页与仓库 Markdown 同源；接收回执和离线测试不等于真实案件端到端已验证。</p>
    </div>
    <article className="ui-panel min-w-0 p-5 sm:p-8 [&_[id]]:scroll-mt-48 lg:[&_[id]]:scroll-mt-24">
      <MarkdownResult content={content} copyCodeBlocks headingIds components={{
        h1: () => null,
        a: ({ href, children }) => <a href={caseIqDocumentationHref(href)}>{children}</a>,
      }} />
      <a href="#docs-top" className="mt-8 inline-block text-xs text-emerald-400 hover:underline">Back to top / 返回顶部</a>
    </article>
  </div>;
}
