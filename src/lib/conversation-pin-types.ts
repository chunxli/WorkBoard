import { z } from "zod";

export const conversationPinSchema = z.object({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  eventId: z.string().regex(/^[a-f0-9]{64}:\d+$/),
  line: z.number().int().min(1).max(8 * 1024 * 1024),
  preview: z.string().max(240),
  timestamp: z.string().nullable(),
  createdAt: z.string(),
});

export type ConversationPin = z.infer<typeof conversationPinSchema>;

export const createConversationPinSchema = z.object({
  runId: z.string().min(1).max(128),
  eventId: conversationPinSchema.shape.eventId,
  line: conversationPinSchema.shape.line,
}).strict();
