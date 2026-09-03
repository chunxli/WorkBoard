import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownResult({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  return (
    <div className={`markdown-result${compact ? " markdown-result-compact" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}