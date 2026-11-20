import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CopyableCodeBlock from "@/components/CopyableCodeBlock";
import { rehypeDocumentationHeadings } from "@/lib/documentation-headings";

const copyableCodeComponents: Components = {
  pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
};

export default function MarkdownResult({
  content,
  compact = false,
  copyCodeBlocks = false,
  headingIds = false,
  components,
}: {
  content: string;
  compact?: boolean;
  copyCodeBlocks?: boolean;
  headingIds?: boolean;
  components?: Components;
}) {
  return (
    <div className={`markdown-result${compact ? " markdown-result-compact" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={headingIds ? [rehypeDocumentationHeadings] : []}
        components={components || copyCodeBlocks ? { ...(copyCodeBlocks ? copyableCodeComponents : {}), ...components } : undefined}>{content}</ReactMarkdown>
    </div>
  );
}