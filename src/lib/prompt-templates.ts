export interface PromptTemplateOption {
  id: string;
  name: string;
  description: string | null;
  content: string;
  builtIn: boolean;
}

export const PROMPT_TEMPLATE_FILE_ACCEPT = ".md,.markdown,.txt,.prompt,text/markdown,text/plain";
export const MAX_PROMPT_TEMPLATE_CONTENT_LENGTH = 100000;

export const BUILT_IN_PROMPT_TEMPLATES: PromptTemplateOption[] = [
  {
    id: "builtin-implement",
    name: "Implement",
    description: "Build a feature with explicit requirements and verification.",
    builtIn: true,
    content: `Implement the following feature:

Goal:
[Describe the desired outcome]

Requirements:
- [Requirement 1]
- [Requirement 2]

Acceptance criteria:
- [How to verify success]

Keep the change focused, follow existing project conventions, run the relevant tests, and summarize the result.`,
  },
  {
    id: "builtin-fix",
    name: "Fix bug",
    description: "Investigate a reproducible problem and fix its root cause.",
    builtIn: true,
    content: `Investigate and fix this issue:

Observed behavior:
[What is happening]

Expected behavior:
[What should happen]

Reproduction or evidence:
[Steps, logs, or failing check]

Find the root cause, make the smallest safe fix, add focused regression coverage, and run the relevant checks.`,
  },
  {
    id: "builtin-investigate",
    name: "Investigate",
    description: "Analyze a question using evidence before proposing changes.",
    builtIn: true,
    content: `Investigate the following question:

Question:
[What needs to be understood]

Known evidence:
- [Evidence or symptom]

Trace the controlling code path, distinguish verified facts from hypotheses, and report the root cause with concrete file references. Do not modify code unless a fix is explicitly requested.`,
  },
  {
    id: "builtin-review",
    name: "Review",
    description: "Review current changes for bugs, regressions, and missing tests.",
    builtIn: true,
    content: `Review the current changes.

Prioritize correctness bugs, security risks, behavioral regressions, concurrency issues, and missing tests. Report findings first, ordered by severity, with concrete file references and reproduction reasoning. Do not modify files.`,
  },
  {
    id: "builtin-tests",
    name: "Add tests",
    description: "Add focused regression coverage for an existing behavior.",
    builtIn: true,
    content: `Add focused tests for the following behavior:

Behavior to protect:
[Describe the contract]

Important cases:
- Happy path
- Failure path
- Relevant edge cases

Follow the repository's existing test patterns, avoid testing implementation details, run the narrow test first, then run the broader relevant suite.`,
  },
  {
    id: "builtin-plan",
    name: "Plan",
    description: "Create an implementation plan without changing code.",
    builtIn: true,
    content: `Create an implementation plan for:

Desired outcome:
[Describe the outcome]

Constraints:
- [Constraint 1]
- [Constraint 2]

Inspect the existing architecture first. Include data-model changes, API and UI work, compatibility concerns, failure handling, migration steps, and executable verification. Do not modify files.`,
  },
];

export function applyPromptTemplate(currentPrompt: string, templateContent: string): string {
  const current = currentPrompt.trimEnd();
  return current ? `${current}\n\n${templateContent}` : templateContent;
}

export function parsePromptTemplateFile(fileName: string, rawContent: string) {
  const content = rawContent.replace(/^\uFEFF/, "");
  if (!content.trim()) throw new Error("Template file is empty");
  if (content.length > MAX_PROMPT_TEMPLATE_CONTENT_LENGTH) {
    throw new Error("Template file must not exceed 100,000 characters");
  }

  const baseName = fileName.replace(/\.(?:md|markdown|txt|prompt)$/i, "").trim();
  return {
    name: (baseName || "Imported template").slice(0, 80),
    content,
  };
}