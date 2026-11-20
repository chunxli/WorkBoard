import { toolExecutionFailed } from "@/lib/tool-execution-outcome";

export interface SessionUsageEntry {
  name: string;
  count: number;
}

export interface SessionMcpUsageEntry extends SessionUsageEntry {
  failedCount: number;
}

export interface SessionUsage {
  mcp: SessionMcpUsageEntry[];
  skills: SessionUsageEntry[];
  partial: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usageName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null;
  return value.trim() || null;
}

function eventId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

export class SessionUsageCounter {
  private readonly seen = new Set<string>();
  private readonly counts = { mcp: new Map<string, SessionMcpUsageEntry>(), skills: new Map<string, number>() };
  private readonly toolCalls = new Map<string, { entry: SessionMcpUsageEntry; failed: boolean }>();
  private partial = false;

  add(event: unknown): void {
    if (!isRecord(event) || (event.type !== "tool.execution_start" &&
        event.type !== "tool.execution_complete" && event.type !== "skill.invoked")) return;
    const data = isRecord(event.data) ? event.data : {};
    const call = eventId(data.toolCallId);
    const callKey = call && JSON.stringify(["mcp", "call", eventId(event.agentId), call]);
    if (event.type === "tool.execution_complete") {
      const tracked = callKey ? this.toolCalls.get(callKey) : undefined;
      if (tracked && !tracked.failed && toolExecutionFailed(data)) {
        tracked.failed = true;
        tracked.entry.failedCount++;
      }
      return;
    }
    const kind = event.type === "skill.invoked" ? "skills" : "mcp";
    if (kind === "mcp" && data.mcpConfigServerName === undefined && data.mcpServerName === undefined &&
        data.mcpToolName === undefined) return;
    const name = kind === "skills" ? usageName(data.name) : usageName(data.mcpConfigServerName) ?? usageName(data.mcpServerName);
    if (!name) { this.skipRecord(); return; }
    const id = eventId(event.id);
    const key = (kind === "mcp" ? callKey : null) ?? (id && JSON.stringify([kind, "event", id]));
    if (key && this.seen.has(key)) return;
    if (key) this.seen.add(key);
    if (kind === "mcp") {
      const entry = this.counts.mcp.get(name) ?? { name, count: 0, failedCount: 0 };
      entry.count++;
      this.counts.mcp.set(name, entry);
      if (callKey) this.toolCalls.set(callKey, { entry, failed: false });
    } else {
      this.counts.skills.set(name, (this.counts.skills.get(name) ?? 0) + 1);
    }
  }

  skipRecord(): void { this.partial = true; }

  snapshot(): SessionUsage {
    const order = (left: SessionUsageEntry, right: SessionUsageEntry) => right.count - left.count || left.name.localeCompare(right.name);
    return {
      mcp: [...this.counts.mcp.values()].map((entry) => ({ ...entry })).sort(order),
      skills: [...this.counts.skills].map(([name, count]) => ({ name, count })).sort(order),
      partial: this.partial,
    };
  }
}
