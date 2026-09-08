import { AuthorProfileView } from "./AuthorProfileView";
import { PublicPage } from "../../../components/public/PublicPage";

// Standalone external-author profile, for members and visitors alike.
//
// NOBODY IS BOUNCED ANY MORE (PAYWALL-ARRIVAL-ADR D5). A member arriving here
// used to be replaced into `/reader?overlay=profile&…` on the premise that a
// member's canonical home for a pane is the workspace. That premise is false
// for someone who has never been there, and weak even for someone who has: a
// link shared with a member should open where the sender meant it to open. The
// reader pane is unaffected — what went is the compulsion, not the overlay.
//
// `ground={false}`: since the profile-pane redesign the surface paints its own
// interior and stands its own height, so PublicPage's bone floor behind it
// would be a layer nobody sees and two stacked viewports would leave dead
// scroll at the foot (see PublicPage's own note). AuthorProfileView is also
// mounted by ProfileOverlay, so its internals stay a workspace question.
//
// `barGround` bone: same as /[username]. Not for the bar (bone is its fallback)
// but for the 8px clearance band, which `ground={false}` otherwise leaves
// transparent over `body`. See PublicPage.
export default function AuthorPage({
  params,
}: {
  params: { authorId: string };
}) {
  return (
    <PublicPage ground={false} barGround="var(--ah-bone)">
      <AuthorProfileView authorId={params.authorId} />
    </PublicPage>
  );
}
