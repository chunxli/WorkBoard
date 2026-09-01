import type { LucideIcon } from "lucide-react";

export default function MetaChip({
  icon: Icon,
  children,
  mono = false,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-950/45 px-2.5 py-1.5 text-xs text-neutral-400">
      <Icon size={13} className="shrink-0 text-neutral-500" aria-hidden="true" />
      <span className={`truncate ${mono ? "font-mono" : ""}`}>{children}</span>
    </span>
  );
}