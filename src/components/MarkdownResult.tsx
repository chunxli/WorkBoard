import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CopyableCodeBlock from "@/components/CopyableCodeBlock";

const copyableCodeComponents: Components = {
  pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
};

export default function MarkdownResult({
  content,
  compact = false,
  copyCodeBlocks = false,
  components,
}: {
  content: string;
  compact?: boolean;
  copyCodeBlocks?: boolean;
  components?: Components;
}) {
  return (
    <div className={`markdown-result${compact ? " markdown-result-compact" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components ?? (copyCodeBlocks ? copyableCodeComponents : undefined)}>{content}</ReactMarkdown>
    </div>
  );
}