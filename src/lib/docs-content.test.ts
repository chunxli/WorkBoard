import { describe, expect, it } from "vitest";
import {
  docsNavigation,
  docsSections,
  operationalLimits,
  releaseNotes,
} from "./docs-content";

describe("in-app documentation content", () => {
  it("keeps navigation anchors unique and backed by content", () => {
    const ids = docsNavigation.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("release-notes");
    expect(docsSections.map((section) => section.id)).toEqual(ids.slice(1));
    expect(docsSections.every((section) => section.features.length > 0)).toBe(true);
  });

  it("keeps release notes newest-first with required latest features", () => {
    const dates = releaseNotes.map((release) => release.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(releaseNotes[0]?.status).toBe("latest");
    const latestTitles = releaseNotes[0]?.notes.map((note) => note.title) ?? [];
    expect(latestTitles).toEqual(expect.arrayContaining([
      "First Run in Terminal",
      "Background System Notifications",
      "In-App Documentation",
    ]));
  });

  it("provides bilingual descriptions and valid in-app entry points", () => {
    for (const section of docsSections) {
      expect(section.subtitle.zh.trim()).not.toBe("");
      expect(section.subtitle.en.trim()).not.toBe("");
      for (const feature of section.features) {
        expect(feature.title.trim()).not.toBe("");
        expect(feature.zh.trim()).not.toBe("");
        expect(feature.en.trim()).not.toBe("");
        if (feature.href) {
          expect(feature.href).toMatch(/^\/[a-z0-9/#-]*$/i);
          expect(feature.label?.trim()).not.toBe("");
        }
      }
    }
    expect(operationalLimits.length).toBeGreaterThanOrEqual(4);
    expect(operationalLimits.every((limit) => limit.zh && limit.en)).toBe(true);
  });
});
