import { SourceSurface } from "./SourceSurface";
import WorkspacePaneRedirect from "../../../components/layout/WorkspacePaneRedirect";
import { PublicPage } from "../../../components/public/PublicPage";

// Standalone source surface. A logged-in visitor is bounced into the workspace
// overlay (WorkspacePaneRedirect); a logged-out one gets this page, which is the
// share / SEO view.
//
// WRAPPED ONLY (tranche 3). PublicPage supplies the bone floor and the nav
// row's bottom band. SourceSurface itself is untouched: SurfaceOverlay mounts
// the same component inside the workspace, so restyling it from here would
// redesign the member surface as a side effect.
export default function SourcePage({ params }: { params: { id: string } }) {
  return (
    <PublicPage>
      <WorkspacePaneRedirect
        overlay="surface"
        params={{ surface: `/source/${params.id}` }}
      />
      <SourceSurface id={params.id} />
    </PublicPage>
  );
}
