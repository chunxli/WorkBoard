function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headingText(node: unknown): string {
  if (!record(node)) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  if (node.tagName === "img" && record(node.properties) && typeof node.properties.alt === "string") return node.properties.alt;
  return Array.isArray(node.children) ? node.children.map(headingText).join("") : "";
}

export function documentationHeadingId(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").trim().replace(/\s+/g, "-") || "section";
}

export function rehypeDocumentationHeadings() {
  return (tree: unknown): void => {
    if (!record(tree) || tree.type !== "root" || !Array.isArray(tree.children)) {
      throw new Error("Documentation Markdown returned an invalid syntax tree.");
    }
    const used = new Set<string>();
    const visit = (node: unknown): void => {
      if (!record(node)) return;
      if (node.type === "element" && typeof node.tagName === "string" && /^h[1-6]$/.test(node.tagName)) {
        const base = documentationHeadingId(headingText(node));
        let id = base;
        let suffix = 0;
        while (used.has(id)) id = `${base}-${++suffix}`;
        used.add(id);
        node.properties = { ...(record(node.properties) ? node.properties : {}), id };
      }
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    tree.children.forEach(visit);
  };
}
