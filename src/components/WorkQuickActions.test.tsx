import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WorkQuickActions from "./WorkQuickActions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

function render(overrides: Partial<ComponentProps<typeof WorkQuickActions>> = {}) {
  return renderToStaticMarkup(<WorkQuickActions
    name="Example Work"
    directoryPath="C:/example"
    canOpenLocal={true}
    terminalRunId="run-1"
    terminalState="ready"
    archiveTarget={{ kind: "work", id: "work-1" }}
    archived={false}
    {...overrides}
  />);
}

describe("WorkQuickActions", () => {
  it("exposes the four familiar actions with tooltips and accessible names", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Quick actions"');
    for (const label of [
      "Open Example Work in Windows Explorer", "Open Example Work in VS Code",
      "Resume Example Work in Windows Terminal", "Archive Example Work",
    ]) {
      expect(markup).toContain(`title="${label}"`);
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain('disabled=""');
  });

  it("keeps server rechecking available for active-looking sessions", () => {
    const markup = render({ terminalState: "active" });
    expect(markup).toContain("Check and resume Example Work in Windows Terminal");
    expect(markup).not.toContain('disabled=""');
  });

  it("disables local launch actions on remote hosts without blocking archive", () => {
    expect(render({ canOpenLocal: false }).match(/disabled=""/g)).toHaveLength(3);
  });

  it("offers restore while keeping archived sessions from resuming", () => {
    const markup = render({ archived: true });
    expect(markup).toContain('aria-label="Restore Example Work"');
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("keeps the Terminal action unavailable without a resumable session", () => {
    const markup = render({ terminalRunId: null, terminalState: "unavailable" });
    expect(markup).toContain("Example Work has no resumable Terminal session");
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });
});