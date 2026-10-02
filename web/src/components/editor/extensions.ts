import { InputRule, type Extensions, type Editor } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { EmbedNode } from "./EmbedNode";
import { ImageWithCaption } from "./ImageWithCaption";
import { PaywallGateNode } from "./PaywallGateNode";
import { isEmbeddableUrl } from "../../lib/media";
import { HREF_PROTOCOLS } from "../../lib/markdown";

// =============================================================================
// The editor extensions that TAKE PART IN MARKDOWN — one home.
//
// `ArticleEditor` spreads this set and appends the three that do not
// (ImageUpload / Placeholder / CharacterCount: none of them parse or serialise,
// and `ImageUpload` cannot be constructed without upload callbacks).
//
// THE IMAGE USED TO BE ON THE OTHER SIDE OF THAT LINE, and the comment saying
// it "takes no part in markdown" was the whole bug: tiptap-markdown falls back
// to prosemirror-markdown's INLINE `image` spec for any node of that name, so
// ours serialised without ever closing its block and welded the next heading,
// list or paragraph onto the picture's own line. It serialises, so it lives
// here — and the round trip now covers it by construction, which is the rule
// this file states one paragraph down. See `ImageWithCaption.ts`.
// `web/tests/editor-markdown-roundtrip.test.ts` calls it directly. Before it
// existed the test's list was HAND-COPIED from the editor, so an extension
// registered in one and not the other was tested by nothing at all.
//
// WHICH SIDE A NEW EXTENSION BELONGS ON: if it parses markdown, serialises to
// markdown, or changes what either produces, it goes here and the round trip
// covers it by construction. A decoration, a placeholder, an upload callback —
// anything with no markdown boundary — stays in `ArticleEditor`. Adding one of
// those here makes the set stop meaning anything.
// =============================================================================

/**
 * Does this href carry a scheme the RENDERER will keep?
 *
 * The list is `markdown.ts`'s — the renderer is the real gate, and a second
 * spelling of the rule here would disagree with it silently: the symptom is a
 * link the writer can make that vanishes when the article is published. A
 * relative or schemeless href throws out of `new URL` and is refused, which is
 * right for a long-form body — a NIP-23 article is read off-site as often as
 * on it, so an href with no origin means nothing.
 */
export function isAllowedLinkHref(href: string | null | undefined): boolean {
  if (!href) return false;
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch {
    return false;
  }
  return HREF_PROTOCOLS.includes(protocol.replace(/:$/, ""));
}

/**
 * `[text](url)` resolves as it is typed.
 *
 * This is a markdown-native product and that is the muscle memory. Without it
 * the brackets stay literal, the serialiser ESCAPES them on the way back out
 * (`\[text\](url)`), and the article publishes showing the syntax.
 *
 * Hand-rolled rather than `markInputRule`, which takes the LAST capture group
 * as the text to mark — here that is the url.
 */
function markdownLinkInputRule(type: MarkType): InputRule {
  return new InputRule({
    // The lookbehind keeps `![alt](src)` out of it — that is an image, and
    // `@tiptap/extension-image`'s own input rule owns it.
    find: /(?<!!)\[([^[\]]+)\]\((\S+?)\)$/,
    handler: ({ state, range, match }) => {
      const label = match[1];
      const href = match[2];
      if (!label || !isAllowedLinkHref(href)) return null;
      const { tr } = state;
      tr.replaceWith(
        range.from,
        range.to,
        state.schema.text(label, [type.create({ href })]),
      );
      // Otherwise the mark is stored and the next word typed joins the link.
      tr.removeStoredMark(type);
      return undefined;
    },
  });
}

/**
 * Ask for a URL and apply it — the toolbar button and `Mod-k` are the same
 * gesture, so they are the same function. `window.prompt` matches what `embed`
 * already does; an inline popover is a comfort follow-up, not a precondition.
 *
 * On a selection that is already a link this REMOVES it, which is what the
 * toolbar's active state offers.
 */
export function promptForLink(editor: Editor): boolean {
  if (editor.isActive("link")) {
    return editor.chain().focus().unsetLink().run();
  }
  const url = window.prompt("Link URL:", "https://");
  if (url === null) return false;
  const href = url.trim();
  if (!href || !isAllowedLinkHref(href)) return false;
  if (editor.state.selection.empty) {
    // Nothing selected — the URL becomes its own link text, rather than a
    // stored mark that silently swallows whatever is typed next.
    return editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: href,
        marks: [{ type: "link", attrs: { href } }],
      })
      .run();
  }
  return editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href })
    .run();
}

const ArticleLink = Link.extend({
  addInputRules() {
    return [markdownLinkInputRule(this.type)];
  },

  addKeyboardShortcuts() {
    // TipTap ships no default shortcut for links.
    return { "Mod-k": () => promptForLink(this.editor) };
  },

  addPasteRules() {
    // Upstream's paste rule linkifies every URL in pasted text. An EMBED is
    // stored as a bare URL on its own line and re-formed on RELOAD by
    // `EmbedNode`'s ruler, which matches a paragraph whose whole content is an
    // embeddable URL — so linkifying one serialises it as `[url](url)`, the
    // ruler no longer matches, and a feature that worked yesterday quietly
    // stops. (Same collision as `autolink`, which is why that is off; the
    // single-line paste is already safe because `EmbedNode`'s own
    // `handlePaste` claims it first, but a MULTI-line paste falls through to
    // here.)
    //
    // Narrowed HERE and not in `isAllowedUri`, deliberately: that gate also
    // governs `setLink` and the paste-over-selection handler, so excluding
    // embeddable URLs there would refuse a DELIBERATE link on a YouTube URL.
    // A paste rule fires on its own; this one now declines the one string
    // whose meaning something else already owns.
    const rules = this.parent?.() ?? [];
    for (const rule of rules) {
      const find = rule.find;
      if (typeof find !== "function") continue;
      rule.find = (text, event) => {
        const found = find(text, event);
        return Array.isArray(found)
          ? found.filter((match) => !isEmbeddableUrl(match.text))
          : found;
      };
    }
    return rules;
  },
}).configure({
  // A click in the editor places the caret; it does not navigate.
  openOnClick: false,
  // DECIDED (D1, 2026-09-11): OFF. Autolink turns a TYPED bare URL into a link
  // mark, which is the embed collision described above — and it is the only one
  // of the three gestures that changes an existing feature's behaviour without
  // being asked. The input rule and `linkOnPaste` cover both gestures anyone
  // actually makes.
  autolink: false,
  // Paste a URL over a selection and the selection becomes a link. This is the
  // gesture people actually use, and its absence was silent data loss.
  linkOnPaste: true,
  // linkifyjs knows http/https/mailto natively; `nostr:` is ours.
  protocols: ["nostr"],
  // The XSS/scheme gate, and the one that matters: it governs `parseHTML`,
  // `renderHTML`, `setLink`/`toggleLink` and the paste rules. NOT `validate`,
  // which upstream deprecated in 2.27 — it now only feeds `shouldAutoLink`
  // (dead here, autolink is off) and warns on every editor create.
  isAllowedUri: (url) => isAllowedLinkHref(url),
});

/**
 * The markdown-relevant extension set, fresh instances per editor.
 */
export function markdownExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
    }),
    Markdown.configure({
      html: false,
      transformCopiedText: true,
    }),
    ArticleLink,
    EmbedNode,
    PaywallGateNode,
    // `inline: false` is what makes it a BLOCK — and what made the stock
    // serialiser wrong. `allowBase64: false`: an image reaches a body through
    // `storeImage` and a URL, never as bytes in the markdown.
    ImageWithCaption.configure({ inline: false, allowBase64: false }),
  ];
}
