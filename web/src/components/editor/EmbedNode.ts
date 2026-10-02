import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { isEmbeddableUrl } from "../../lib/media";

// =============================================================================
// EmbedNode TipTap Extension
//
// Custom node for the URLs the body renderer turns into a player — YouTube,
// Vimeo, Spotify; `isEmbeddableUrl` is DEFINED by that renderer
// (`articleEmbed`), so this can never claim a provider that publishes as a
// bare link. When the user pastes one on its own line, the editor replaces it
// with an embed node.
//
// In Markdown serialisation, embeds are stored as plain URLs on their own
// line (Nostr convention). The rendering layer enhances them.
// =============================================================================

/**
 * The URL has already passed `isEmbeddableUrl`, but it is being concatenated
 * into markup — escape it anyway.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface EmbedNodeOptions {
  onEmbedInserted?: (url: string) => void;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embedNode: {
      setEmbed: (options: { src: string }) => ReturnType;
    };
  }
}

export const EmbedNode = Node.create<EmbedNodeOptions>({
  name: "embed",

  group: "block",

  atom: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-embed]",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-embed": "",
        class: "p-4 my-4 bg-grey-100",
      }),
      [
        "a",
        {
          href: HTMLAttributes.src,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "text-sm text-crimson hover:text-crimson-dark break-all",
        },
        HTMLAttributes.src,
      ],
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(node.attrs.src + "\n\n");
        },
        parse: {
          setup(markdownit: any) {
            markdownit.core.ruler.after("inline", "embed_url", (state: any) => {
              const tokens = state.tokens;
              for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].type !== "paragraph_open") continue;
                const inline = tokens[i + 1];
                if (!inline || inline.type !== "inline") continue;
                const close = tokens[i + 2];
                if (!close || close.type !== "paragraph_close") continue;

                const text = inline.content.trim();
                if (!text || text.includes("\n")) continue;
                if (!isEmbeddableUrl(text)) continue;

                const newToken = new state.Token("embed", "", 0);
                newToken.block = true;
                // PAIRS, not an object: markdown-it's `renderAttrs`/`attrGet`
                // iterate `attrs` as `[name, value]` tuples, so an object drops
                // the URL on the floor.
                newToken.attrs = [["src", text]];
                tokens.splice(i, 3, newToken);
              }
            });
            // Without this the token has no renderer rule, `renderToken` builds
            // its tag from the empty `token.tag`, and the whole paragraph —
            // URL included — comes out as `<>`. That is a DELETION: every path
            // that hands stored markdown back to the editor (reopening a draft,
            // editing a published article, the note→article seed) lost every
            // bare embed URL, and the next autosave wrote the loss back.
            markdownit.renderer.rules.embed = (tokens: any, idx: number) =>
              `<div data-embed="" src="${escapeAttr(
                tokens[idx].attrGet("src") ?? "",
              )}"></div>\n`;
          },
        },
      },
    };
  },

  addCommands() {
    return {
      setEmbed:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("embedDetection"),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain")?.trim();
            if (!text) return false;

            // Only handle single-line URL pastes
            if (text.includes("\n")) return false;
            if (!isEmbeddableUrl(text)) return false;

            event.preventDefault();

            const { state } = view;
            const { tr, schema } = state;
            const nodeType = schema.nodes.embed;
            if (!nodeType) return false;

            const node = nodeType.create({ src: text });
            const transaction = tr.replaceSelectionWith(node);
            view.dispatch(transaction);

            return true;
          },
        },
      }),
    ];
  },
});
