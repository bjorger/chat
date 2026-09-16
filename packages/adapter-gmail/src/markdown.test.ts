import { describe, expect, it } from "vitest";
import { GmailFormatConverter } from "./markdown";

describe("Gmail formatting", () => {
  const formatter = new GmailFormatConverter();

  it("treats incoming email text literally", () => {
    const result = formatter.toAst("*literal* <person@example.com>");
    expect(result.children).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: "*literal* <person@example.com>" }],
      },
    ]);
  });

  it("renders canonical Markdown without treating raw messages as Markdown", () => {
    expect(formatter.renderPostable({ markdown: "**hello**" })).toBe(
      "**hello**"
    );
    expect(formatter.renderPostable({ raw: "a_b" })).toBe("a_b");
  });
});
