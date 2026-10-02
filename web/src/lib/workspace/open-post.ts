import type { Post } from "../post/types";
import { originWebUrl } from "../post/origin-url";
import { useReader } from "../../stores/reader";
import { useWorkspaceSurface } from "../../stores/workspaceSurface";

// =============================================================================
// Opening a post in a reader — the one home, and the one place the escape ban
// is decided for a post.
//
// Five surfaces mount the same card log in both registers (the profile's Work
// and Social tabs, the external author profile, the source surface, the tag
// browser), and four of them opened an article with a bare
// `router.push("/article/…")`. Inside the workspace that is exactly the escape
// the ban forbids: it navigates the whole route away from the overlay world,
// so the reader who clicked a card in a profile pane loses the pane, the
// workspace under it, and every feed's scroll position — and Back does not
// bring them back.
//
// The register test is the workspace's own mount flag, not an `inOverlay` prop
// threaded down five component trees: `ReaderOverlay` is mounted by
// `WorkspaceView` and nowhere else, so "is the workspace on screen" IS "is
// there a reader pane to open" — one fact, asked of the thing that knows it.
// Off the workspace the standalone routes are the correct destination and the
// push stands.
//
// ORIGIN URL: an external post's reader target is `originWebUrl(post)`, never
// `post.origin.uri` verbatim. That column is the item's stable identity, which
// for RSS is `guid ?? link` — and a guid is very often not a URL at all
// (`urn:uuid:…`, `tag:…`, a bare integer). Handed one, the extractor answers
// "Could not extract" and a hostile one would have been rendered as an href.
// The card's own `→` has always gone through this helper, so until now the
// card and the reader disagreed about whether the same post had a permalink;
// they now agree, and a post with no resolvable origin URL simply does not
// open (see `canOpenPostInReader`, which is what suppresses the affordance).
// =============================================================================

interface PushRouter {
  push: (href: string) => void;
}

/** Is there anywhere for this post to open? Callers suppress the affordance
 *  when there is not, rather than offering a click that does nothing. */
export function canOpenPostInReader(post: Post): boolean {
  if (post.author.pubkey) return !!post.dTag;
  return !!originWebUrl(post);
}

/** Open a post in the reader pane inside the workspace; navigate to its
 *  standalone route anywhere else. */
export function openPostInReader(post: Post, router: PushRouter): void {
  const inWorkspace = useWorkspaceSurface.getState().mounted;

  if (post.author.pubkey) {
    if (!post.dTag) return;
    if (inWorkspace) {
      useReader.getState().openNative(post.dTag, {
        postId: post.id,
        preview: { title: post.body.title, summary: post.body.summary },
      });
    } else {
      router.push(`/article/${encodeURIComponent(post.dTag)}`);
    }
    return;
  }

  const url = originWebUrl(post);
  if (!url) return;
  if (inWorkspace) {
    useReader.getState().openExternal(url, {
      postId: post.id,
      title: post.body.title,
      siteName: post.origin.sourceName,
    });
  } else {
    router.push(`/read/${encodeURIComponent(post.id)}`);
  }
}
