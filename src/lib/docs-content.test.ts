import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  docsNavigation,
  docsSections,
  operationalLimits,
  releaseNotes,
} from "./docs-content";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
} from "./work-attachment-types";

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
    expect(releaseNotes.filter((release) => release.status === "latest")).toHaveLength(1);
    const latestTitles = releaseNotes[0]?.notes.map((note) => note.title) ?? [];
    expect(latestTitles).toEqual(expect.arrayContaining([
      "First Run in Terminal",
      "Background System Notifications",
      "In-App Documentation",
      "Selected Directory References",
      "Message Attachments",
      "Conversation Workspace",
      "Compact Conversation Activity",
      "Default-on Login Autostart",
      "Windows PowerShell Compatibility",
      "Optional Skill Comparison UI",
      "Source Upgrade & Data Retention",
      "Quick Start & Initial Setup",
      "Refresh-Stable Input Order",
      "Run Concurrency",
    ]));
  });

  it("keeps Quick Start discoverable and its commands aligned with the standalone guide", () => {
    expect(docsNavigation[1].id).toBe("quick-start");
    const quickStart = docsSections[0];
    expect(quickStart.id).toBe("quick-start");
    expect(quickStart.features.map((feature) => feature.title)).toEqual([
      "Prerequisites", "Windows PowerShell", "macOS / Linux", "Prompt Templates",
      "Preferred Working Directory", "Recommended Execution Defaults", "Your First Work",
    ]);
    const readme = readFileSync(new URL("../../README.quickstart.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    for (const feature of quickStart.features.filter((feature) => feature.code)) {
      expect(readme).toContain(feature.code);
      expect(feature.code).toContain("npm ci\nnpm run background:start");
    }
    expect(quickStart.features.find((feature) => feature.title === "Windows PowerShell")?.code)
      .toContain("if (-not (Test-Path .env))");
    expect(quickStart.features.find((feature) => feature.title === "macOS / Linux")?.code)
      .toContain("test -f .env || cp .env.example .env");
  });

  it("documents the real initial setup entry points and persistence boundaries", () => {
    const features = docsSections[0].features;
    expect(features.find((feature) => feature.title === "Prompt Templates")).toMatchObject({
      href: "/settings#prompt-templates",
      en: expect.stringContaining("Append or Replace"),
    });
    expect(features.find((feature) => feature.title === "Preferred Working Directory")).toMatchObject({
      href: "/settings",
      en: expect.stringContaining("same browser/user"),
    });
    const defaults = features.find((feature) => feature.title === "Recommended Execution Defaults");
    expect(defaults?.href).toBe("/settings#execution-defaults");
    for (const label of ["Copilot CLI", "Auto", "Standard tools", "Save defaults", "not existing items"]) {
      expect(defaults?.en).toContain(label);
    }
    expect(features.find((feature) => feature.title === "Your First Work")?.en).toContain("back up");
    expect(docsSections.find((section) => section.id === "operations")?.features
      .find((feature) => feature.title === "Run Concurrency")?.en).toContain("defaults to 5");
  });

  it("retains bilingual release content and historical released milestones", () => {
    for (const release of releaseNotes) {
      expect(release.title.zh.trim()).not.toBe("");
      expect(release.title.en.trim()).not.toBe("");
      expect(release.notes.length).toBeGreaterThan(0);
      expect(new Set(release.notes.map((note) => note.title)).size).toBe(release.notes.length);
      for (const note of release.notes) {
        expect(note.title.trim()).not.toBe("");
        expect(note.zh.trim()).not.toBe("");
        expect(note.en.trim()).not.toBe("");
      }
    }
    expect(releaseNotes.filter((release) => release.status === "released").map(({ date, version }) => ({ date, version })))
      .toEqual([
        { date: "2026-09-03", version: "e461da3" },
        { date: "2026-09-01", version: "4315291" },
      ]);
  });

  it("keeps documented attachment limits aligned with the runtime contract", () => {
    const mib = 1024 * 1024;
    const latest = releaseNotes[0].notes.find((note) => note.title === "Message Attachments");
    const feature = docsSections.flatMap((section) => section.features).find((feature) => feature.title === "Message Attachments");
    for (const content of [latest, feature]) {
      expect(content?.en).toContain(`${MAX_ATTACHMENT_BYTES / mib} MiB`);
      expect(content?.en).toContain(`${MAX_MESSAGE_ATTACHMENT_BYTES / mib} MiB`);
      expect(content?.en).toContain(`${MAX_MESSAGE_ATTACHMENTS} files`);
      expect(content?.zh).toContain(`${MAX_ATTACHMENT_BYTES / mib} MiB`);
      expect(content?.zh).toContain(`${MAX_MESSAGE_ATTACHMENT_BYTES / mib} MiB`);
      expect(content?.zh).toContain(`${MAX_MESSAGE_ATTACHMENTS} 个`);
    }
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
