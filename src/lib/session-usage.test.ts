import { describe, expect, it } from "vitest";
import { SessionUsageCounter } from "./session-usage";

describe("recorded Session usage", () => {
  it("counts MCP starts by server and treats completions only as outcomes, not additional calls", () => {
    const counter = new SessionUsageCounter();
    const data = { toolCallId: "call-1", mcpServerName: "SupportIQ", mcpToolName: "case_get" };
    for (const event of [
      { type: "session.mcp_servers_loaded", data: { servers: [{ name: "ConfiguredOnly" }] } },
      { type: "permission.requested", data: { permissionRequest: { kind: "mcp", serverName: "PermissionOnly" } } },
      { type: "tool.execution_start", data: { toolCallId: "local", toolName: "SupportIQ-looking-name" } },
      { type: "tool.execution_start", id: "one", data },
      { type: "tool.execution_start", id: "duplicate", data },
      { type: "tool.execution_complete", data: { ...data, success: false } },
      { type: "tool.execution_start", data: { ...data, toolCallId: "call-2", mcpToolName: "get_case_notes" } },
      { type: "tool.execution_start", agentId: "a", data },
      { type: "tool.execution_start", data: { ...data, toolCallId: "call-3", mcpConfigServerName: "Example:SupportIQ" } },
    ]) counter.add(event);
    expect(counter.snapshot()).toEqual({
      mcp: [{ name: "SupportIQ", count: 3, failedCount: 1 }, { name: "Example:SupportIQ", count: 1, failedCount: 0 }],
      skills: [], partial: false,
    });
  });

  it("counts one explicit failure per matched call and does not infer failures from orphan results or a Run failure", () => {
    const counter = new SessionUsageCounter();
    const start = (toolCallId: string, agentId?: string) =>
      ({ type: "tool.execution_start", agentId, data: { toolCallId, mcpServerName: "Example" } });
    const complete = (toolCallId: string, result: Record<string, unknown>, agentId?: string) =>
      ({ type: "tool.execution_complete", agentId, data: { toolCallId, ...result } });
    const failure = complete("same-id", { success: false }, "one");
    for (const event of [
      start("same-id", "one"), start("same-id", "two"), start("pending"), start("legacy"), start("success"),
      failure, failure,
      complete("same-id", { success: true }, "two"),
      complete("legacy", { error: { code: "synthetic-failure" } }),
      complete("success", { success: true, error: null, result: { error: null, content: "failed in unrelated text" } }),
      complete("orphaned", { success: false, mcpServerName: "Example" }),
      complete("pending", { success: false }, "wrong-agent"),
      { type: "session.error", data: { toolCallId: "pending" } },
    ]) counter.add(event);
    expect(counter.snapshot().mcp).toEqual([{ name: "Example", count: 5, failedCount: 2 }]);
  });

  it("counts repeated real skill invocations, but not duplicates, user mentions, or skills merely listed as available", () => {
    const counter = new SessionUsageCounter();
    const event = { type: "skill.invoked", id: "invoke-1", data: { name: "triage", content: "private skill body", path: "C:\\private" } };
    counter.add(event);
    counter.add(event);
    counter.add({ ...event, id: "invoke-2" });
    counter.add({ type: "skill.invoked", id: "invoke-3", data: { name: "other-skill" } });
    counter.add({ type: "user.message", data: { content: "/triage" } });
    counter.add({ type: "session.skills_loaded", data: { skills: [{ name: "loaded-only" }] } });
    expect(counter.snapshot()).toEqual({
      mcp: [], skills: [{ name: "triage", count: 2 }, { name: "other-skill", count: 1 }], partial: false,
    });
  });

  it("preserves readable names and explicitly marks malformed recorded invocation metadata as partial", () => {
    const counter = new SessionUsageCounter();
    counter.add({ type: "tool.execution_start", data: { mcpToolName: "unattributed" } });
    counter.add({ type: "skill.invoked", data: { name: "bad\rname" } });
    counter.add({ type: "skill.invoked", data: { name: "x".repeat(257) } });
    counter.add({ type: "skill.invoked", data: { name: "  调查助手  " } });
    expect(counter.snapshot()).toEqual({ mcp: [], skills: [{ name: "调查助手", count: 1 }], partial: true });
  });
});
