import { SourceSurface } from "./SourceSurface";
import { PublicPage } from "../../../components/public/PublicPage";

// Standalone source surface — the share / SEO view, served to members and
// visitors alike since D5 deleted the workspace bounce (PAYWALL-ARRIVAL-ADR).
//
// WRAPPED ONLY (tranche 3). PublicPage supplies the bone floor and the nav
// row's bottom band. SourceSurface itself is untouched: SurfaceOverlay mounts
// the same component inside the workspace, so restyling it from here would
// redesign the member surface as a side effect.
export default function SourcePage({ params }: { params: { id: string } }) {
  return (
    <PublicPage>
      <SourceSurface id={params.id} />
    </PublicPage>
  );
}
