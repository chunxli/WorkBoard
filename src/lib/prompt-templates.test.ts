import { describe, expect, it } from "vitest";
import {
  applyPromptTemplate,
  BUILT_IN_PROMPT_TEMPLATES,
  extractPromptTemplateApiError,
  filterSavedPrompts,
  MAX_PROMPT_TEMPLATE_CONTENT_LENGTH,
  parsePromptTemplateFile,
  resolveSavedPromptDraft,
} from "./prompt-templates";

describe("prompt templates", () => {
  it("provides the core built-in workflows", () => {
    expect(BUILT_IN_PROMPT_TEMPLATES.map((template) => template.name)).toEqual([
      "Implement",
      "Fix bug",
      "Investigate",
      "Review",
      "Add tests",
      "Plan",
    ]);
    expect(BUILT_IN_PROMPT_TEMPLATES.every((template) => template.content.length > 0)).toBe(true);
  });

  it("fills an empty prompt", () => {
    expect(applyPromptTemplate("", "Template content")).toBe("Template content");
  });

  it("appends to an existing prompt with one blank line", () => {
    expect(applyPromptTemplate("Existing prompt\n\n", "Template content")).toBe(
      "Existing prompt\n\nTemplate content"
    );
  });

  it("derives the template name and strips a UTF-8 BOM", () => {
    expect(parsePromptTemplateFile("release-check.prompt.md", "\uFEFF# Release\nShip it")).toEqual({
      name: "release-check.prompt",
      content: "# Release\nShip it",
    });
  });

  it("rejects empty and oversized files", () => {
    expect(() => parsePromptTemplateFile("empty.md", " \n")).toThrow("Template file is empty");
    expect(() => parsePromptTemplateFile("large.txt", "x".repeat(100001))).toThrow(
      "Template file must not exceed 100,000 characters"
    );
  });

  it("resolves saved prompt drafts in append and replace modes and enforces character limits", () => {
    expect(resolveSavedPromptDraft("", "Analyze ADO work items", "append")).toEqual({
      ok: true,
      value: "Analyze ADO work items",
    });
    expect(resolveSavedPromptDraft("Case 2603120040001234", "Analyze ADO work items", "append")).toEqual({
      ok: true,
      value: "Case 2603120040001234\n\nAnalyze ADO work items",
    });
    expect(resolveSavedPromptDraft("Case 2603120040001234", "Analyze ADO work items", "replace")).toEqual({
      ok: true,
      value: "Analyze ADO work items",
    });
    expect(resolveSavedPromptDraft("", "   ", "replace")).toEqual({
      ok: false,
      error: "Saved prompt content is empty.",
    });
    expect(
      resolveSavedPromptDraft("prefix", "x".repeat(MAX_PROMPT_TEMPLATE_CONTENT_LENGTH), "append")
    ).toEqual({
      ok: false,
      error: "The message would exceed the 100,000-character Prompt limit.",
    });
  });

  it("filters user saved prompts across name, description, and content", () => {
    const saved = [
      { id: "1", name: "ADO", description: "Pull active bugs", content: "Check DevDiv work items" },
      { id: "2", name: "AOAI", description: null, content: "Inspect quota and throttling metrics" },
      { id: "3", name: "WinDnD", description: "Drag and drop trace", content: "Analyze OLE clipboard logs" },
    ];
    expect(filterSavedPrompts(saved, "")).toHaveLength(3);
    expect(filterSavedPrompts(saved, "throttling").map((item) => item.name)).toEqual(["AOAI"]);
    expect(filterSavedPrompts(saved, "ACTIVE BUGS").map((item) => item.name)).toEqual(["ADO"]);
    expect(filterSavedPrompts(saved, "windnd").map((item) => item.name)).toEqual(["WinDnD"]);
  });

  it("extracts readable validation and conflict errors from prompt template API responses", () => {
    expect(extractPromptTemplateApiError({ error: "A template with this name already exists" }, "Fallback")).toBe(
      "A template with this name already exists"
    );
    expect(
      extractPromptTemplateApiError(
        { error: { formErrors: [], fieldErrors: { name: ["String must contain at least 1 character(s)"] } } },
        "Fallback"
      )
    ).toBe("String must contain at least 1 character(s)");
    expect(extractPromptTemplateApiError(null, "Fallback")).toBe("Fallback");
  });
});
