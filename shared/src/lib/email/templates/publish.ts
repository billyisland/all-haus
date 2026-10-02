import { button, byline, fine, link, muted, type EmailContent } from "../layout.js";

// =============================================================================
// A Writer published something — to each reader who asked to hear about it.
// Goes out on the broadcast stream (`sendBroadcastEmail`), and every one
// carries its own signed unsubscribe link.
// =============================================================================

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}

export interface PublishEmailParams {
  writerName: string;
  writerAvatarUrl: string | null;
  title: string;
  summary: string | null;
  contentFree: string | null;
  articleUrl: string;
  unsubscribeUrl: string;
}

export function publishNotificationEmail(args: PublishEmailParams): EmailContent {
  const excerpt = args.summary || truncateToWords(args.contentFree ?? "", 40);
  return {
    subject: `${args.writerName}: ${args.title}`,
    heading: args.title,
    listUnsubscribe: args.unsubscribeUrl,
    blocks: [
      byline(args.writerName, args.writerAvatarUrl),
      ...(excerpt ? [muted(excerpt)] : []),
      button(args.articleUrl, "Read on all.haus"),
      fine(
        `You're getting this because you subscribe to ${args.writerName} and asked to hear when they publish. `,
        link(args.unsubscribeUrl, "Unsubscribe"),
      ),
    ],
  };
}
