import { describe, it, expect } from "vitest";
import { normaliseEmail, type PostmarkInboundPayload } from "./email.js";

// =============================================================================
// The text/plain branch builds markup out of something that was never markup.
//
// The HTML branch sanitises; this one wrapped the body in `<p>` raw, and the
// result is stored as `content_html` and rendered with
// `dangerouslySetInnerHTML` (MIRROR-AUDIT-2026-09-08 §2.2). Anyone who learns
// an ingest address could inject script into that member's feed.
// =============================================================================

function payload(over: Partial<PostmarkInboundPayload> = {}): PostmarkInboundPayload {
  return {
    From: "Someone <someone@example.com>",
    FromFull: { Email: "someone@example.com", Name: "Someone" },
    To: "in+abc@example.com",
    ToFull: [{ Email: "in+abc@example.com", Name: "" }],
    Subject: "A newsletter",
    HtmlBody: "",
    TextBody: "",
    MessageID: "msg-1",
    Date: "Tue, 09 Sep 2026 10:00:00 +0000",
    Attachments: [],
    Headers: [],
    ...over,
  };
}

describe("normaliseEmail — the text/plain branch", () => {
  it("escapes the body rather than wrapping it raw", () => {
    const item = normaliseEmail(
      payload({ TextBody: `<img src=x onerror="alert(1)"> & "quoted"` }),
    );
    expect(item.contentHtml).not.toContain("<img");
    expect(item.contentHtml).toContain("&lt;img");
    expect(item.contentHtml).toContain("&amp;");
    expect(item.contentHtml).toContain("&quot;");
    // contentText is the raw body by design — it is never rendered as markup.
    expect(item.contentText).toContain("<img");
  });

  it("keeps the paragraph and line-break structure it is there to build", () => {
    const item = normaliseEmail(payload({ TextBody: "one\ntwo\n\nthree" }));
    expect(item.contentHtml).toBe("<p>one<br>two</p><p>three</p>");
  });

  // Escaping must run BEFORE the <br> substitution: the other order escapes
  // the tag the substitution just inserted, and the reader sees "&lt;br&gt;".
  it("escapes before substituting <br>, not after", () => {
    const item = normaliseEmail(payload({ TextBody: "a\nb" }));
    expect(item.contentHtml).toContain("<br>");
    expect(item.contentHtml).not.toContain("&lt;br&gt;");
  });

  it("still sanitises the HTML branch when one is present", () => {
    const item = normaliseEmail(
      payload({ HtmlBody: "<p>hi</p><script>alert(1)</script>" }),
    );
    expect(item.contentHtml).not.toContain("<script");
  });
});

describe("normaliseEmail — the Date header", () => {
  it("keeps an ordinary past date", () => {
    const item = normaliseEmail(payload());
    expect(item.publishedAt.toISOString()).toBe("2026-09-09T10:00:00.000Z");
  });

  // Without the clamp a forged or skewed header pins the issue to the top of
  // the feed until the date comes round, and breaks the one-future-week
  // premise the reading counts' scan rests on (WORKSPACE-QUEUE-ADR §IV.2).
  it("clamps a date more than a day ahead to now", () => {
    const before = Date.now();
    const item = normaliseEmail(payload({ Date: "Mon, 01 Jan 2099 00:00:00 +0000" }));
    expect(item.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(item.publishedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("keeps a date inside the day's allowance", () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const item = normaliseEmail(payload({ Date: soon.toUTCString() }));
    expect(Math.abs(item.publishedAt.getTime() - soon.getTime())).toBeLessThan(1000);
  });
});
