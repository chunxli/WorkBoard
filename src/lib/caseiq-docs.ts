import { readFile } from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";

export const caseIqDocumentation = {
  integration: {
    href: "/docs/caseiq",
    file: "caseiq-integration.md",
    title: "CaseIQ integration",
    zh: "CaseIQ 集成说明：网页 Runtime、用户 Prompt 执行、Conversation、Follow Up、宿主注册与当前验证状态。",
    en: "CaseIQ web runtime: your Prompt, Conversation, Follow Up, host setup and current verification.",
  },
  bridge: {
    href: "/docs/caseiq/bridge",
    file: "caseiq-native-bridge.md",
    title: "CaseIQ native bridge",
    zh: "网页 Prompt 与旧 Terminal 共用的原生桥：握手、私有数据、进程事实和验证边界。",
    en: "The shared native bridge: web Prompt transport, legacy Terminal, private data and verification boundaries.",
  },
} as const;

export type CaseIqDocumentId = keyof typeof caseIqDocumentation;

export async function readCaseIqDocumentation(id: CaseIqDocumentId) {
  if (!await getSessionUserId()) redirect("/api/auth/signin");
  const document = caseIqDocumentation[id];
  const content = await readFile(path.join(process.cwd(), "docs", document.file), "utf8");
  return { document, content };
}

export function caseIqDocumentationHref(href: string | undefined): string | undefined {
  if (!href) return href;
  const hash = href.indexOf("#");
  const file = (hash < 0 ? href : href.slice(0, hash)).replace(/^\.\//, "");
  const document = Object.values(caseIqDocumentation).find((item) => item.file === file);
  return document ? document.href + (hash < 0 ? "" : href.slice(hash)) : href;
}
