import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import CreateWebhookForm from "@/components/CreateWebhookForm";
import CreateTokenForm from "@/components/CreateTokenForm";
import DeleteButton from "@/components/DeleteButton";
import PromptTemplatesSettings from "@/components/PromptTemplatesSettings";
import WorkPathShortcutsSettings from "@/components/WorkPathShortcutsSettings";
import PageHeader from "@/components/PageHeader";
import ExecutionDefaultsSettings from "@/components/ExecutionDefaultsSettings";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";
import SystemNotificationSettings from "@/components/SystemNotificationSettings";
import { getSystemNotificationSettings } from "@/lib/notification-settings";

function SettingsSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 grid gap-4 border-t border-neutral-800 py-7 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
      <h2 className="text-sm font-bold text-neutral-200 lg:sticky lg:top-24 lg:self-start">
        {title}
      </h2>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

export default async function SettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const [
    repos,
    webhooks,
    tokens,
    workPathShortcuts,
    promptTemplates,
    executionDefaults,
    notificationSettings,
  ] = await Promise.all([
    prisma.repo.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.webhookConfig.findMany({ where: { repo: { userId } }, include: { repo: true } }),
    prisma.apiToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.workPathShortcut.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    prisma.promptTemplate.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true, content: true },
    }),
    getUserExecutionDefaults(userId),
    getSystemNotificationSettings(userId),
  ]);

  return (
    <div>
      <PageHeader eyebrow="Workspace configuration" title="Settings" />

      <SettingsSection id="execution-defaults" title="Execution defaults">
        <ExecutionDefaultsSettings initialValue={executionDefaults} />
      </SettingsSection>

      <SettingsSection id="notifications" title="Notifications">
        <SystemNotificationSettings initialEnabled={notificationSettings.enabled} />
      </SettingsSection>

      <SettingsSection title="Work directories">
        <WorkPathShortcutsSettings shortcuts={workPathShortcuts} />
      </SettingsSection>

      <SettingsSection id="prompt-templates" title="Prompt templates">
        <PromptTemplatesSettings initialTemplates={promptTemplates} />
      </SettingsSection>

      <SettingsSection title="GitHub webhooks">
        <CreateWebhookForm repos={repos} />
        <div className="ui-table-shell">
          <table className="ui-table min-w-[560px]">
            <thead>
              <tr>
                <th className="px-4 py-2">Resource</th>
                <th className="px-4 py-2">Endpoint</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {webhooks.map((wh) => (
                <tr key={wh.id} className="border-t border-neutral-700">
                  <td className="px-4 py-2">{wh.repo.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                    /api/webhooks/github/{wh.repoId}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DeleteButton url={`/api/webhooks/${wh.id}`} />
                  </td>
                </tr>
              ))}
              {webhooks.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-neutral-500">
                    No webhooks configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      <SettingsSection title="API tokens">
        <CreateTokenForm />
        <div className="ui-table-shell">
          <table className="ui-table min-w-[620px]">
            <thead>
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((tok) => (
                <tr key={tok.id} className="border-t border-neutral-700">
                  <td className="px-4 py-2">{tok.name}</td>
                  <td className="px-4 py-2 text-neutral-400">{new Date(tok.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-neutral-400">
                    {tok.lastUsedAt ? new Date(tok.lastUsedAt).toLocaleString() : "Never"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DeleteButton url={`/api/tokens/${tok.id}`} />
                  </td>
                </tr>
              ))}
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-neutral-500">
                    No API tokens yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </div>
  );
}
