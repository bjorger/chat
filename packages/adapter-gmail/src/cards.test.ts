import { describe, expect, it } from "vitest";
import { cardToGmailText } from "./cards";

describe("Gmail card fallback", () => {
  it("keeps text and links while omitting callback buttons", () => {
    expect(
      cardToGmailText({
        type: "card",
        title: "Review",
        children: [
          { type: "text", content: "Ready" },
          { type: "link", label: "Open", url: "https://example.com/review" },
          {
            type: "actions",
            children: [{ type: "button", id: "approve", label: "Approve" }],
          },
        ],
      })
    ).toBe("**Review**\nReady\nOpen (https://example.com/review)");
  });
});
