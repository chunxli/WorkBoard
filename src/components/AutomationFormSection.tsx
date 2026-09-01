import type { LucideIcon } from "lucide-react";

export default function AutomationFormSection({
  step,
  title,
  icon: Icon,
  children,
}: {
  step: string;
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 border-t border-neutral-800 p-4 first:border-0 sm:p-5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
      <div className="flex items-center gap-3 self-start">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-neutral-700 bg-neutral-950 font-mono text-[10px] font-bold text-neutral-500">
          {step}
        </span>
        <h2 className="flex items-center gap-2 text-sm font-bold text-neutral-200">
          <Icon size={15} className="text-emerald-400" aria-hidden="true" />
          {title}
        </h2>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}