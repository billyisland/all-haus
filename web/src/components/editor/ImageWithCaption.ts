import Image from "@tiptap/extension-image";

// =============================================================================
// ImageWithCaption — the article editor's picture node.
//
// TWO things the stock `@tiptap/extension-image` gets wrong here, and the
// second is the one a reader sees.
//
// 1. IT SERIALISES AS AN INLINE IMAGE. tiptap-markdown falls back to
//    prosemirror-markdown's `image` spec for any node named `image`, and that
//    spec is written for prosemirror's own INLINE image: it calls
//    `state.write("![…](…)")` and stops. Ours is configured `inline: false` — a
//    block — so nothing ever closed the block, and whatever followed the
//    picture was welded onto its line:
//
//      ![pic](url)After.        → one <p>, text inline beside the picture
//      ![pic](url)## A heading  → the HEADING IS GONE; `##` mid-line is text
//      ![pic](url)- one         → the list is gone
//
//    Silent, and it fires the first time anybody illustrates an article above a
//    heading. `state.closeBlock(node)` rather than the `"\n\n"` its two
//    neighbours write (EmbedNode, PaywallGateNode): a picture can sit inside a
//    list item, where a raw newline skips the list's own indent prefix and
//    corrupts the list — closeBlock emits the separator through the delimiter
//    stack, which is what knows about the prefix.
//
// 2. A WRITER COULD NOT SAY "THIS IS A CAPTION". Markdown has no caption
//    construct and the node offered no affordance, so a caption was an ordinary
//    paragraph — the external reader's symptom, with no signal to detect
//    because the author was never given a way to record the intent. The carrier
//    is the image TITLE (`![alt](src "caption")`), which is plain CommonMark,
//    already an attribute of this node, already serialised by the spec above,
//    and already parsed back by remark — so the round trip needed nothing new.
//    `renderMarkdown` promotes a lone titled image to `<figure><figcaption>`;
//    a client that only renders markdown shows it as a tooltip rather than
//    losing it, which is why this and not embedded HTML.
//
// ALT IS NOT A CAPTION and the two are kept apart: alt describes the picture
// for somebody who cannot see it, a caption is read by everybody. Filling one
// from the other would be an accessibility regression wearing a convenience.
//
// The node view renders the real `<figure>`/`<figcaption>` the reader will get,
// so the editor and the reader take the SAME CSS (`.ah-caption-voice`, one
// home in globals.css) — the measure-fidelity rule applied to captions.
// =============================================================================

const CAPTION_PLACEHOLDER = "Add a caption";

export const ImageWithCaption = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const alt = state.esc(node.attrs.alt || "");
          const src = String(node.attrs.src || "").replace(/[()]/g, "\\$&");
          // Escape the BACKSLASH as well as the quote. A caption ending in
          // `\` (a Windows path, say) otherwise escapes the closing quote
          // itself, and markdown-it — the editor's own reload parser — stops
          // seeing an image at all: the next draft open shows the markdown as
          // a literal paragraph and the next autosave persists it, so the
          // picture is deleted from the document with nothing said.
          const title = node.attrs.title
            ? ` "${String(node.attrs.title).replace(/[\\"]/g, "\\$&")}"`
            : "";
          state.write(`![${alt}](${src}${title})`);
          // The whole point — see (1) above.
          state.closeBlock(node);
        },
        // No `parse`: remark/markdown-it already produce an `image` token with
        // `title`, and the stock `parseHTML` picks the attribute off the <img>.
        parse: {},
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const figure = document.createElement("figure");
      figure.className = "ah-editor-figure";
      figure.contentEditable = "false";

      const img = document.createElement("img");
      const applyImg = (n: typeof node) => {
        img.src = n.attrs.src ?? "";
        if (n.attrs.alt) img.alt = n.attrs.alt;
        else img.removeAttribute("alt");
      };
      applyImg(node);

      const caption = document.createElement("figcaption");
      caption.className = "ah-caption-input";
      caption.contentEditable = "true";
      caption.dataset.placeholder = CAPTION_PLACEHOLDER;
      caption.textContent = node.attrs.title ?? "";

      figure.appendChild(img);
      figure.appendChild(caption);

      const markHasCaption = () => {
        figure.dataset.hasCaption = caption.textContent?.trim() ? "true" : "false";
      };
      markHasCaption();

      const commit = () => {
        const text = (caption.textContent ?? "").replace(/\s+/g, " ").trim();
        markHasCaption();
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeAttribute(pos, "title", text || null),
        );
      };

      caption.addEventListener("input", commit);
      caption.addEventListener("blur", commit);
      caption.addEventListener("keydown", (event) => {
        // A caption is one line. Enter leaves it rather than growing it, and
        // Escape abandons the field — neither may reach the document, or the
        // keystroke splits the paragraph the picture is sitting in.
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          caption.blur();
          editor.commands.focus();
        }
      });

      return {
        dom: figure,
        // The caption's own DOM is not the document's: every mutation and event
        // inside it is ours, and letting ProseMirror read either makes it
        // rewrite the node view mid-keystroke and drop the caret.
        ignoreMutation: () => true,
        stopEvent: (event: Event) =>
          event.target instanceof Node && caption.contains(event.target),
        update: (updated) => {
          if (updated.type.name !== node.type.name) return false;
          applyImg(updated);
          const next = updated.attrs.title ?? "";
          // Only write back when the value actually differs, or every keystroke
          // rewrites the element the caret is in.
          if (document.activeElement !== caption && caption.textContent !== next) {
            caption.textContent = next;
          }
          markHasCaption();
          return true;
        },
      };
    };
  },
});

export { CAPTION_PLACEHOLDER };
