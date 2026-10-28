import { z } from "zod";
import type { ElicitationSchema } from "@github/copilot-sdk";

export type RuntimeInteraction =
  | { id: string; kind: "permission"; title: string; detail: string; managed: boolean }
  | { id: string; kind: "question"; question: string; choices: string[]; allowFreeform: boolean }
  | { id: string; kind: "form"; message: string; schema: ElicitationSchema }
  | { id: string; kind: "url"; message: string; url: string };

export interface RuntimeMcpServer {
  name: string;
  status: string;
  authentication: "copilot-account" | "native" | "oauth" | "terminal" | "entra-host-required" | "none";
}

export interface ManagedRuntimeState {
  sessionId: string;
  ready: boolean;
  requests: RuntimeInteraction[];
  mcp: RuntimeMcpServer[];
  mcpError: string | null;
  thirdPartyEnabled: boolean | null;
}

const fieldValue = z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.array(z.string()).max(1000)]);
export const runtimeReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), requestId: z.string().uuid(), approved: z.boolean() }).strict(),
  z.object({ kind: z.literal("question"), requestId: z.string().uuid(), answer: z.string().min(1).max(100_000) }).strict(),
  z.object({
    kind: z.literal("elicitation"),
    requestId: z.string().uuid(),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), fieldValue).optional(),
  }).strict(),
]);
export type RuntimeReply = z.infer<typeof runtimeReplySchema>;

const binding = { runId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128) };
export const runtimeActionSchema = z.discriminatedUnion("action", [
  z.object({ ...binding, action: z.literal("reply"), reply: runtimeReplySchema }).strict(),
  z.object({ ...binding, action: z.literal("mcp-login"), serverName: z.string().min(1).max(256) }).strict(),
  z.object({ ...binding, action: z.literal("mcp-tools"), serverName: z.string().min(1).max(256) }).strict(),
  z.object({ ...binding, action: z.literal("mcp-reload") }).strict(),
]);

export class RuntimeControlError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "RuntimeControlError";
  }
}

export function safeRuntimeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RuntimeControlError(502, "Copilot returned an invalid sign-in URL. Use Open Terminal."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && loopback)) {
    throw new RuntimeControlError(502, "Copilot returned an unsafe sign-in URL. Use Open Terminal.");
  }
  return url.href;
}
