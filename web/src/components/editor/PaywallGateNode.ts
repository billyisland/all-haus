import { Node, mergeAttributes } from "@tiptap/core";
import { PAYWALL_GATE_MARKER } from "../../lib/gate-marker";

// =============================================================================
// PaywallGateNode — TipTap Extension
//
// Renders a visible paywall marker inline in the editor, like a horizontal
// rule or embed. The author inserts it at the exact point where the free
// preview ends and the paywalled section begins.
//
// In the editor: a dashed green bar labelled "PAYWALL — content below is paid"
// with a remove button.
//
// On publish: the editor splits content at this node's position — everything
// above becomes freeContent, everything below becomes paywallContent.
//
// Only one gate marker is allowed per document. Inserting a second one
// removes the first.
//
// In Markdown serialisation: stored as a special comment marker
//   <!-- paywall-gate -->
// which the publish pipeline detects to split the content.
// =============================================================================

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paywallGate: {
      insertPaywallGate: () => ReturnType;
      removePaywallGate: () => ReturnType;
    };
  }
}

// The marker string lives in `lib/gate-marker.ts`, beside the one function
// that splits at it, so a server route can split a draft without loading the
// editor; it is re-exported here for the editor code that imports it from the
// node. This node is still the pair's other end: its renderer and parse rules
// below are what write and read the marker.
export { PAYWALL_GATE_MARKER };

export const PaywallGateNode = Node.create({
  name: "paywallGate",

  group: "block",

  atom: true, // non-editable, non-splittable

  draggable: true, // can be dragged to reposition

  parseHTML() {
    return [
      {
        tag: "div[data-paywall-gate]",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-paywall-gate": "",
        class: "paywall-gate-marker",
        contenteditable: "false",
      }),
      ["span", { class: "gate-label" }, "Paywall — content below is paid"],
      ["span", { class: "gate-remove", "data-gate-remove": "" }, "✕ remove"],
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any) {
          state.write(PAYWALL_GATE_MARKER + "\n\n");
        },
        parse: {
          setup(markdownit: any) {
            // Two arms, because the marker arrives as a DIFFERENT token
            // depending on `Markdown.configure({ html })`, and the editor ships
            // `html: false`. Under `html: true` markdown-it emits an
            // `html_block`; under `html: false` its html_block rule returns
            // immediately and the marker lands as an ordinary paragraph. The
            // D334 fix (2026-05-16) handled only the first, against a parser
            // that cannot emit one — so the gate was silently lost on every
            // edit of a paywalled article, and the piece republished free.
            // Keep both arms so the rule cannot die again if `html` is flipped.
            markdownit.core.ruler.after(
              "inline",
              "paywall_gate",
              (state: any) => {
                const tokens = state.tokens;
                for (let i = 0; i < tokens.length; i++) {
                  const token = tokens[i];
                  if (
                    token.type === "html_block" &&
                    token.content.trim() === PAYWALL_GATE_MARKER
                  ) {
                    token.type = "paywall_gate";
                    token.content = "";
                    token.block = true;
                    continue;
                  }
                  if (token.type !== "paragraph_open") continue;
                  const inline = tokens[i + 1];
                  if (!inline || inline.type !== "inline") continue;
                  const close = tokens[i + 2];
                  if (!close || close.type !== "paragraph_close") continue;
                  if (inline.content.trim() !== PAYWALL_GATE_MARKER) continue;
                  const gate = new state.Token("paywall_gate", "", 0);
                  gate.block = true;
                  tokens.splice(i, 3, gate);
                }
              },
            );
            // The half the D334 fix never had. tiptap-markdown does not hand
            // the editor the token stream — it calls `md.render()` and
            // DOM-parses the HTML. A token with no renderer rule falls to
            // `renderToken`, which builds its tag from `token.tag` (empty
            // here), so the gate renders as `<>` and `parseHTML` never matches.
            markdownit.renderer.rules.paywall_gate = () =>
              '<div data-paywall-gate=""></div>';
          },
        },
      },
    };
  },

  addCommands() {
    return {
      insertPaywallGate:
        () =>
        ({ chain, state }) => {
          // Remove any existing gate first (only one allowed)
          const { doc } = state;
          let existingPos: number | null = null;
          doc.descendants((node, pos) => {
            if (node.type.name === "paywallGate") {
              existingPos = pos;
              return false;
            }
          });

          if (existingPos !== null) {
            return chain()
              .deleteRange({ from: existingPos, to: Number(existingPos) + 1 })
              .insertContent({ type: this.name })
              .run();
          }

          return chain().insertContent({ type: this.name }).run();
        },

      removePaywallGate:
        () =>
        ({ commands, state }) => {
          const { doc } = state;
          let gatePos: number | null = null;
          doc.descendants((node, pos) => {
            if (node.type.name === "paywallGate") {
              gatePos = pos;
              return false;
            }
          });

          if (gatePos !== null) {
            return commands.deleteRange({
              from: gatePos,
              to: Number(gatePos) + 1,
            });
          }

          return false;
        },
    };
  },

  // Handle click on the remove button
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      dom.classList.add("paywall-gate-marker");
      dom.contentEditable = "false";
      dom.setAttribute("data-paywall-gate", "");
      // Explain kind (C2): the writer's side of the paywall line, the
      // counterpart of the reader-facing `reader.gate`.
      dom.setAttribute("data-explain", "editor.gate");

      const label = document.createElement("span");
      label.classList.add("gate-label");
      label.textContent = "Paywall — content below is paid";

      const remove = document.createElement("span");
      remove.classList.add("gate-remove");
      remove.textContent = "✕ remove";
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        editor.commands.removePaywallGate();
      });

      dom.appendChild(label);
      dom.appendChild(remove);

      return { dom };
    };
  },
});
