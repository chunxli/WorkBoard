interface CopilotJsonEvent {
  type?: unknown;
  agentId?: unknown;
  data?: {
    toolCallId?: unknown;
    toolName?: unknown;
    agentDisplayName?: unknown;
    agentName?: unknown;
    content?: unknown;
  };
}

export interface CopilotCompletionSummary {
  openSubagents: { id: string; name: string }[];
  openTools: { id: string; name: string }[];
  rootFinalOutput: string | null;
  taskComplete: boolean;
  sessionIdle: boolean;
}

export class CopilotCompletionTracker {
  private buffer = "";
  private readonly openSubagents = new Map<string, string>();
  private readonly openTools = new Map<string, string>();
  private rootFinalOutput: string | null = null;
  private taskComplete = false;
  private sessionIdle = false;

  push(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  finish(): CopilotCompletionSummary {
    if (this.buffer) this.consumeLine(this.buffer);
    this.buffer = "";
    return {
      openSubagents: [...this.openSubagents].map(([id, name]) => ({ id, name })),
      openTools: [...this.openTools].map(([id, name]) => ({ id, name })),
      rootFinalOutput: this.rootFinalOutput,
      taskComplete: this.taskComplete,
      sessionIdle: this.sessionIdle,
    };
  }

  private consumeLine(line: string): void {
    let event: CopilotJsonEvent;
    try {
      event = JSON.parse(line) as CopilotJsonEvent;
    } catch {
      return;
    }
    const agentId =
      typeof event.agentId === "string"
        ? event.agentId
        : typeof event.data?.toolCallId === "string"
          ? event.data.toolCallId
          : null;
    if (event.type === "subagent.started" && agentId) {
      const name =
        typeof event.data?.agentDisplayName === "string"
          ? event.data.agentDisplayName
          : typeof event.data?.agentName === "string"
            ? event.data.agentName
            : agentId;
      this.openSubagents.set(agentId, name);
      this.rootFinalOutput = null;
      this.taskComplete = false;
    } else if (
      (event.type === "subagent.completed" || event.type === "subagent.failed") &&
      agentId
    ) {
      this.openSubagents.delete(agentId);
    } else if (event.type === "tool.execution_start" && typeof event.data?.toolCallId === "string") {
      const toolCallId = event.data.toolCallId;
      const toolName = typeof event.data.toolName === "string" ? event.data.toolName : toolCallId;
      this.openTools.set(toolCallId, toolName);
      this.rootFinalOutput = null;
      this.taskComplete = false;
    } else if (
      event.type === "tool.execution_complete" &&
      typeof event.data?.toolCallId === "string"
    ) {
      this.openTools.delete(event.data.toolCallId);
    } else if (
      event.type === "assistant.message" &&
      typeof event.agentId !== "string" &&
      typeof event.data?.content === "string" &&
      event.data.content.trim() &&
      this.openSubagents.size === 0 &&
      this.openTools.size === 0
    ) {
      this.rootFinalOutput = event.data.content;
    } else if (event.type === "session.task_complete") {
      this.taskComplete = true;
    } else if (event.type === "session.idle") {
      this.sessionIdle = true;
    }
  }
}