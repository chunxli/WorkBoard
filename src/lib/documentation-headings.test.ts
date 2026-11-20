import { describe, expect, it } from "vitest";
import { documentationHeadingId, rehypeDocumentationHeadings } from "./documentation-headings";

describe("documentation anchors", () => {
  it("handles mixed Chinese/English titles without dropping readable anchor text", () => {
    expect(documentationHeadingId("首次使用：从注册到原生会话")).toBe("首次使用从注册到原生会话");
    expect(documentationHeadingId("最近 CaseIQ 会话与设置复用")).toBe("最近-caseiq-会话与设置复用");
    expect(documentationHeadingId("Setup & Resume")).toBe("setup-resume");
    expect(documentationHeadingId("   ")).toBe("section");
  });

  it("rejects a malformed tree instead of claiming usable anchors", () => {
    expect(() => rehypeDocumentationHeadings()(null)).toThrow("invalid syntax tree");
    expect(() => rehypeDocumentationHeadings()({ type: "root" })).toThrow("invalid syntax tree");
  });
});
