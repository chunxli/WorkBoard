"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  History,
  ListTodo,
  Settings,
  SquareKanban,
  type LucideIcon,
} from "lucide-react";

const links: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/work", label: "Work", icon: SquareKanban },
  { href: "/tasks", label: "Automations", icon: ListTodo },
  { href: "/runs", label: "Runs", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex min-w-max items-center gap-1" aria-label="Primary navigation">
      {links.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium ${
              active
                ? "bg-neutral-800 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            }`}
          >
            <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </div>
  );
}