import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const tools = ["case_get", "unapproved_test_tool", "restricted_test_tool"].map((name) => ({
  name, description: "Local synthetic permission fixture; no customer, file or network access.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false },
}));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "workboard-synthetic-permission", version: "1.0.0" } };
  } else if (request.method === "tools/list") result = { tools };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/call" && tools.some((tool) => tool.name === request.params.name)) {
    await appendFile(process.env.WORKBOARD_SYNTHETIC_TOOL_LOG, `${JSON.stringify({ name: request.params.name })}\n`);
    result = { content: [{ type: "text", text: "WORKBOARD_SYNTHETIC_MCP_PERMISSION_OK" }] };
  } else {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown synthetic method." } }));
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
