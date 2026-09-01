import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRunEmitter, type CopilotRunEvent } from "@/lib/copilot-runner";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    select: { id: true, status: true },
  });
  if (!run) return new Response("Not found", { status: 404 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let emitter = getRunEmitter(id);
      let listener: ((event: CopilotRunEvent) => void) | null = null;
      let closed = false;
      const send = (event: CopilotRunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (event.type === "exit" || event.type === "error") {
          closed = true;
          clearInterval(heartbeat);
          clearInterval(waitForEmitter);
          if (emitter && listener) emitter.off("event", listener);
          controller.close();
        }
      };

      const subscribe = () => {
        const candidate = getRunEmitter(id);
        if (!candidate || candidate === emitter && listener) return;
        if (emitter && listener) emitter.off("event", listener);
        emitter = candidate;
        listener = (event: CopilotRunEvent) => send(event);
        emitter.on("event", listener);
      };

      // SSE comment lines (ignored by EventSource) keep the connection from going idle and
      // being silently dropped by any intermediary (or the browser) between real output bursts —
      // Copilot CLI can go quiet for a while mid-run while it's "thinking" between tool calls.
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);

      subscribe();
      const waitForEmitter = setInterval(async () => {
        if (closed) return;
        subscribe();
        if (emitter) return;
        const current = await prisma.run.findUnique({ where: { id }, select: { status: true } });
        if (current && current.status !== "PENDING" && current.status !== "RUNNING") {
          send({
            type: "exit",
            code: null,
            timedOut: current.status === "TIMED_OUT",
            cancelled: current.status === "CANCELLED",
          });
        }
      }, 750);

      if (run.status !== "PENDING" && run.status !== "RUNNING" && !emitter) {
        send({
          type: "exit",
          code: null,
          timedOut: run.status === "TIMED_OUT",
          cancelled: run.status === "CANCELLED",
        });
      }

      const cleanup = () => {
        closed = true;
        if (emitter && listener) emitter.off("event", listener);
        clearInterval(heartbeat);
        clearInterval(waitForEmitter);
      };
      _req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defensive: disable any intermediary's response buffering for this streamed response.
      "X-Accel-Buffering": "no",
    },
  });
}
