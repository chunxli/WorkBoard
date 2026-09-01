/**
 * Copilot CLI's `--output-format json` emits one JSON event object per line (JSONL),
 * including many streaming "_delta" chunks that are superseded by a final non-delta
 * event. This turns a raw event line into a short human-readable summary for display,
 * or null to skip noisy/duplicate events. Not an official schema reference — the CLI's
 * JSON event shape isn't publicly documented and may change between versions.
 */
export function summarizeCopilotJsonLine(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw;
  }

  const type = typeof obj.type === "string" ? obj.type : "unknown";
  if (type.endsWith("_delta")) return null;

  const data = (obj.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case "user.message":
      return `📝 ${String(data.content ?? "")}`;
    case "assistant.message": {
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (toolRequests.length > 0) {
        const names = toolRequests
          .map((t) => (t as Record<string, unknown>).name)
          .filter(Boolean)
          .join(", ");
        return `🔧 calling: ${names}`;
      }
      return data.content ? `🤖 ${String(data.content)}` : null;
    }
    case "assistant.reasoning":
      return data.content ? `🧠 ${String(data.content)}` : null;
    case "tool.execution_start":
      return `▶ ${String(data.toolName ?? "tool")}`;
    case "tool.execution_complete": {
      const success = data.success !== false;
      return `${success ? "✔" : "✖"} ${String(data.toolName ?? "tool")}`;
    }
    case "assistant.turn_start":
    case "assistant.turn_end":
    case "session.mcp_server_status_changed":
    case "session.skills_loaded":
    case "session.tools_updated":
    case "model.call_start":
    case "mcp.tools.list_changed":
      return null;
    default:
      return `· ${type}`;
  }
}

export function formatCopilotLogLines(
  lines: string[],
  outputFormat: "text" | "json"
): string[] {
  if (outputFormat === "json") return lines;
  return lines
    .map((line) => summarizeCopilotJsonLine(line))
    .filter((line): line is string => line !== null);
}
