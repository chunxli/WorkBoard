import type { LucideIcon } from "lucide-react";

export default function SectionHeading({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-500">
          <Icon size={14} aria-hidden="true" />
        </span>
        <h2 className="text-base font-bold text-neutral-100">{title}</h2>
      </div>
      {children}
    </div>
  );
}