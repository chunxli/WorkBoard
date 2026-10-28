"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

export default function RunDuration({ startedAt, finishedAt, status, initialLabel, className }: {
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  initialLabel: string;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);
  const ticking = status === "RUNNING" && startedAt !== null && finishedAt === null;

  useEffect(() => {
    if (!ticking) return;
    const update = () => { if (!document.hidden) setNow(Date.now()); };
    const initial = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [startedAt, finishedAt, ticking]);

  return <span aria-label="Run elapsed time" className={className}>
    {ticking && now !== null ? formatDuration(startedAt, null, now) : initialLabel}
  </span>;
}
