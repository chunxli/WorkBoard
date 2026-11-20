import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CaseIqWorkPanel from "./CaseIqWorkPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("CaseIQ native fallback panel", () => {
  it("explains the same-provider native path without claiming web or SDK controls", () => {
    const markup = renderToStaticMarkup(<CaseIqWorkPanel workId="owned-work" />);
    expect(markup).toContain("Native Terminal fallback");
    expect(markup).toContain("no SDK session control");
    expect(markup).toContain('href="/docs/caseiq"');
    expect(markup).toContain("Open CaseIQ Terminal");
    expect(markup).toContain("not inherited");
    expect(markup).toContain("Filter CaseIQ support packs");
    expect(markup).toContain('multiple=""');
    expect(markup).not.toContain('checked=""');
  });

  it("keeps unavailable or archived launch actions explicitly disabled", () => {
    const markup = renderToStaticMarkup(<CaseIqWorkPanel workId="owned-work" disabledReason="Restore this Work before opening CaseIQ." />);
    expect(markup).toContain("Restore this Work before opening CaseIQ.");
    expect(markup).toContain("disabled");
  });

  it("keeps pack search outside the launch form so Enter cannot implicitly start CaseIQ", () => {
    const markup = renderToStaticMarkup(<CaseIqWorkPanel workId="owned-work" />);
    const search = markup.indexOf('type="search"');
    const form = markup.indexOf("<form");
    expect(search).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(search);
  });
});
