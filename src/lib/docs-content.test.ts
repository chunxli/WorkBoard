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
      "Quick Work Renaming",
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
      "Composer Keyboard Shortcuts",
      "Missing Directory Auto-archive",
      "Add to Queue",
      "Precise Conversation Pins",
      "Work File References",
      "Conversation Code Copy",
      "Scroll-to-load Earlier History",
    ]));
  });

  it("documents queued delivery separately from immediate SDK Steering", () => {
    const features = docsSections.flatMap((section) => section.features);
    const followUp = features.find((feature) => feature.title === "In-App Follow Up");
    const steering = features.find((feature) => feature.title === "Live Steering");
    expect(followUp?.en).toContain("FIFO");
    expect(followUp?.en).toContain("failure, cancellation or timeout");
    expect(followUp?.en).toContain("Refresh/restart");
    for (const feature of [followUp, steering]) {
      expect(feature?.en).toContain("Add to Queue");
      expect(feature?.en).toContain("Steer now");
    }
    expect(steering?.en).toContain("rejects new immediate CLI Steering");
    expect(steering?.en).toContain("permitting safe queueing");
    expect(steering?.en).not.toContain("edit an unsent draft during execution");
  });

  it("documents exact session-scoped Pins and the compact copy affordance", () => {
    const features = docsSections.flatMap((section) => section.features);
    const pins = features.find((feature) => feature.title === "Precise Conversation Pins");
    const copy = features.find((feature) => feature.title === "Conversation Code Copy");
    for (const label of ["Session", "database", "code lines", "Back to latest", "changed/replaced/missing"]) {
      expect(pins?.en).toContain(label);
    }
    for (const label of ["borderless", "28px", "44px", "green check", "Copy/Pin"]) {
      expect(copy?.en).toContain(label);
    }
  });

  it("documents conversation-aware history continuation, retained records and retry boundaries", () => {
    const note = releaseNotes[0].notes.find((note) => note.title === "Scroll-to-load Earlier History");
    for (const label of ["until", "user/assistant", "attachment-only", "Tool-only", "subagent-only", "empty pages", "Retry", "Pinned-history"]) {
      expect(note?.en).toContain(label);
    }
    expect(note?.en).not.toContain("load one earlier page");
  });

  it("keeps path-only references distinct from attachment upload and documents Pin deployment/backups", () => {
    const features = docsSections.flatMap((section) => section.features);
    const paths = features.find((feature) => feature.title === "Work File References");
    expect(paths?.en).toContain("absolute path");
    expect(paths?.en).toContain("neither uploads nor sends");
    const migrations = features.find((feature) => feature.title === "Source Updates & Migrations");
    expect(migrations?.code).toBe("npm run background:restart\nnpm run background:status");
    for (const label of ["WorkConversationPin", "database is not reset", "--skip-build", "wait for active Runs"]) {
      expect(migrations?.en).toContain(label);
    }
    const recovery = features.find((feature) => feature.title === "Startup Recovery");
    expect(recovery?.en).toContain("dependency/FIFO order");
    expect(recovery?.en).toContain("one Run per Session");
    const backup = features.find((feature) => feature.title === "Data & Backup");
    expect(backup?.en).toContain("queued Runs and Pin anchors");
    expect(backup?.en).toContain("cannot reconstruct conversation text");
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

  it("documents Enter-to-send with newline, IME and disabled-button safeguards", () => {
    const followUp = docsSections.flatMap((section) => section.features).find((feature) => feature.title === "In-App Follow Up");
    const note = releaseNotes[0].notes.find((note) => note.title === "Composer Keyboard Shortcuts");
    for (const text of [followUp?.zh, followUp?.en]) {
      expect(text).toContain("Enter");
      expect(text).toContain("Shift+Enter");
    }
    expect(followUp?.en).toContain("IME confirmation does not send");
    expect(followUp?.en).toContain("disabled Send button");
    expect(note?.en).toContain("Enter to send");
    expect(note?.en).toContain("Shift+Enter");
    expect(note?.en).toContain("held Enter does not repeat-submit");
  });

  it("documents quick card renaming without changing folders, history or archived status", () => {
    const note = releaseNotes[0].notes.find((note) => note.title === "Quick Work Renaming");
    const feature = docsSections.find((section) => section.id === "work-lifecycle")?.features
      .find((feature) => feature.title === "Quick Work Renaming");
    expect(feature?.href).toBe("/work");
    for (const content of [note, feature]) {
      for (const label of ["Current", "Archived", "pencil", "Enter", "Esc", "1-200", "folder", "Prompt", "Run history", "draft"]) {
        expect(content?.en).toContain(label);
      }
      for (const label of ["Enter", "Esc", "1-200", "Prompt", "Run"]) {
        expect(content?.zh).toContain(label);
      }
    }
    expect(feature?.en).toContain("IME confirmation does not save");
    expect(feature?.en).toContain("duplicate submissions");
    expect(feature?.en).toContain("archived status");
    expect(feature?.en).toContain("long names wrap");
  });

  it("documents automatic missing-root archiving without treating file errors as directory deletion", () => {
    const archive = docsSections.flatMap((section) => section.features).find((feature) => feature.title === "Archive & Restore");
    expect(archive?.en).toContain("30-second background scan");
    expect(archive?.en).toContain("missing child files");
    expect(archive?.en).toContain("foreign/unknown hosts");
    expect(archive?.en).toContain("Restore manually");
    expect(releaseNotes[0].notes.map((note) => note.title)).toContain("Missing Directory Auto-archive");
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
