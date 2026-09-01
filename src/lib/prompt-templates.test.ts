import { describe, expect, it } from "vitest";
import {
  applyPromptTemplate,
  BUILT_IN_PROMPT_TEMPLATES,
  parsePromptTemplateFile,
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
});
