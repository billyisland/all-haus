import { AuthorProfileView } from "./AuthorProfileView";
import WorkspacePaneRedirect from "../../../components/layout/WorkspacePaneRedirect";
import { PublicPage } from "../../../components/public/PublicPage";

// Standalone external-author profile. A logged-in visitor is bounced into the
// workspace overlay; a logged-out one gets this page.
//
// `ground={false}`: since the profile-pane redesign the surface paints its own
// interior and stands its own height, so PublicPage's bone floor behind it
// would be a layer nobody sees and two stacked viewports would leave dead
// scroll at the foot (see PublicPage's own note). AuthorProfileView is also
// mounted by ProfileOverlay, so its internals stay a workspace question.
export default function AuthorPage({
  params,
}: {
  params: { authorId: string };
}) {
  return (
    <PublicPage ground={false}>
      <WorkspacePaneRedirect
        overlay="profile"
        params={{ author: params.authorId }}
      />
      <AuthorProfileView authorId={params.authorId} />
    </PublicPage>
  );
}
