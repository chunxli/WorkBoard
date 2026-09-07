import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowUpRight,
  BookOpen,
  CircleAlert,
  GitCommitHorizontal,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import {
  docsNavigation,
  docsSections,
  operationalLimits,
  releaseNotes,
} from "@/lib/docs-content";
import { getSessionUserId } from "@/lib/session";

export const metadata: Metadata = {
  title: "Docs | Work Board",
  description: "Bilingual Work Board feature documentation and release notes",
};

function SectionNavigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav
      aria-label="Documentation sections"
      className={
        mobile
          ? "flex flex-wrap gap-2 pb-2 lg:hidden"
          : "sticky top-24 hidden space-y-1 lg:block"
      }
    >
      {docsNavigation.map((item, index) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className={
            mobile
              ? "shrink-0 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs font-semibold text-neutral-300 hover:border-neutral-700 hover:text-white"
              : "group flex items-start gap-3 rounded-md px-3 py-2.5 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-white"
          }
        >
          {!mobile && (
            <span className="mt-0.5 font-mono text-[10px] text-neutral-600 group-hover:text-emerald-400">
              {String(index + 1).padStart(2, "0")}
            </span>
          )}
          <span>
            <span className="block font-semibold">{item.label}</span>
            <span lang="zh-CN" className="mt-0.5 block text-[11px] font-normal text-neutral-500">
              {item.zh}
            </span>
          </span>
        </a>
      ))}
    </nav>
  );
}

function ReleaseNotes() {
  return (
    <section id="release-notes" className="scroll-mt-24">
      <div className="border-b border-neutral-800 pb-5">
        <div className="flex items-center gap-2 text-emerald-400">
          <GitCommitHorizontal size={16} aria-hidden="true" />
          <p className="text-[11px] font-bold uppercase">Release Notes</p>
        </div>
        <h2 className="mt-2 text-xl font-bold text-white">版本说明</h2>
        <p lang="en" className="mt-2 max-w-3xl text-sm leading-6 text-neutral-500">
          Product changes are grouped by source milestone. “Latest changes” describes the current source tree and does not imply that a running background process has already been restarted.
        </p>
      </div>

      <div>
        {releaseNotes.map((release) => (
          <article
            key={`${release.date}-${release.version}`}
            className="grid gap-4 border-b border-neutral-800 py-7 md:grid-cols-[9rem_minmax(0,1fr)] md:gap-8"
          >
            <div>
              <time dateTime={release.date} className="font-mono text-xs text-neutral-500">
                {release.date}
              </time>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-sm border px-2 py-1 font-mono text-[10px] font-bold uppercase ${
                    release.status === "latest"
                      ? "border-emerald-700/70 bg-emerald-950/60 text-emerald-300"
                      : "border-neutral-700 bg-neutral-900 text-neutral-400"
                  }`}
                >
                  {release.status === "latest" ? "Latest source" : "Released"}
                </span>
                <span className="font-mono text-[11px] text-neutral-500">{release.version}</span>
              </div>
            </div>

            <div className="min-w-0">
              <h3 className="text-base font-bold text-neutral-100">{release.title.zh}</h3>
              <p lang="en" className="mt-1 text-sm text-neutral-500">
                {release.title.en}
              </p>
              <ul className="mt-5 divide-y divide-neutral-800 border-t border-neutral-800">
                {release.notes.map((note) => (
                  <li key={note.title} className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-5">
                    <span className="text-sm font-semibold text-neutral-200">{note.title}</span>
                    <div className="min-w-0 space-y-1">
                      <p lang="zh-CN" className="text-sm leading-6 text-neutral-300">
                        {note.zh}
                      </p>
                      <p lang="en" className="text-xs leading-5 text-neutral-500">
                        {note.en}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default async function DocsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  return (
    <div className="space-y-7">
      <PageHeader eyebrow="Product reference" title="Docs">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <BookOpen size={15} aria-hidden="true" />
          <span>中文 + English</span>
        </div>
      </PageHeader>

      <div className="max-w-3xl space-y-2">
        <p lang="zh-CN" className="text-base leading-7 text-neutral-300">
          Work Board 的功能手册与版本记录。功能名保持英文界面原文，中文说明操作方式，英文说明用于快速对照。
        </p>
        <p lang="en" className="text-sm leading-6 text-neutral-500">
          The feature guide and release history for Work Board. UI names stay in English, with Chinese guidance and concise English reference text.
        </p>
      </div>

      <SectionNavigation mobile />

      <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="min-w-0">
          <SectionNavigation />
        </aside>

        <div className="min-w-0 space-y-14">
          <ReleaseNotes />

          {docsSections.map((section, sectionIndex) => (
            <section key={section.id} id={section.id} className="scroll-mt-24">
              <div className="border-b border-neutral-800 pb-5">
                <p className="font-mono text-[10px] font-bold text-emerald-400">
                  {String(sectionIndex + 2).padStart(2, "0")}
                </p>
                <h2 className="mt-2 text-xl font-bold text-white">{section.title}</h2>
                <p lang="zh-CN" className="mt-2 max-w-3xl text-sm leading-6 text-neutral-300">
                  {section.subtitle.zh}
                </p>
                <p lang="en" className="mt-1 max-w-3xl text-xs leading-5 text-neutral-500">
                  {section.subtitle.en}
                </p>
              </div>

              <div className="divide-y divide-neutral-800">
                {section.features.map((feature) => (
                  <article
                    key={feature.title}
                    className="grid gap-2 py-5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6"
                  >
                    <h3 className="text-sm font-bold text-neutral-100">{feature.title}</h3>
                    <div className="min-w-0">
                      <p lang="zh-CN" className="text-sm leading-6 text-neutral-300">
                        {feature.zh}
                      </p>
                      <p lang="en" className="mt-1 text-xs leading-5 text-neutral-500">
                        {feature.en}
                      </p>
                      {feature.href && feature.label && (
                        <Link
                          href={feature.href}
                          className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300"
                        >
                          {feature.label}
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </Link>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {section.id === "operations" && (
                <div className="mt-6 border-l-2 border-amber-500/70 pl-5">
                  <div className="flex items-center gap-2 text-amber-300">
                    <CircleAlert size={16} aria-hidden="true" />
                    <h3 className="text-sm font-bold">Important boundaries / 重要边界</h3>
                  </div>
                  <ol className="mt-4 space-y-4">
                    {operationalLimits.map((limit, index) => (
                      <li key={limit.en} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
                        <span className="font-mono text-xs text-neutral-600">{index + 1}.</span>
                        <div>
                          <p lang="zh-CN" className="text-sm leading-6 text-neutral-300">
                            {limit.zh}
                          </p>
                          <p lang="en" className="mt-1 text-xs leading-5 text-neutral-500">
                            {limit.en}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
