import { Node, mergeAttributes } from "@tiptap/core";

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

export const PAYWALL_GATE_MARKER = "<!-- paywall-gate -->";

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
          state.write("<!-- paywall-gate -->\n\n");
        },
        parse: {
          setup(markdownit: any) {
            markdownit.core.ruler.after(
              "block",
              "paywall_gate",
              (state: any) => {
                const tokens = state.tokens;
                for (let i = 0; i < tokens.length; i++) {
                  const token = tokens[i];
                  if (
                    token.type === "html_block" &&
                    token.content.trim() === "<!-- paywall-gate -->"
                  ) {
                    token.type = "paywallGate";
                    token.content = "";
                  }
                }
              },
            );
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
