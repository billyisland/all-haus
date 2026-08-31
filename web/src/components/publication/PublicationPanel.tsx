"use client";

// =============================================================================
// PublicationPanel — the publication surface rendered inside the surface overlay
// (useSurfaceOverlay). One body for all five publication views (home · about ·
// masthead · archive · subscribe), switched by the `view` prop; an in-overlay
// nav swaps between them by re-opening the store on the matching view (which
// replaceStates the real /pub/<slug>[/<view>] URL, so Back still closes the
// whole overlay and direct visits resolve the same surfaces full-page). Article
// rows open the reader overlay (useReader) in place rather than navigating to
// /pub/:slug/:article and escaping the workspace. The full-page /pub/[slug]/**
// routes still render their own server-side surfaces on direct visits.
//
// THIS FILE OWNS ARRANGEMENT AND LOADING, NOTHING ELSE. The header is
// `PublicationMasthead` (the same block the public pages carry, in its overlay
// mode) and every body is a `pub-sections.tsx` component — because this panel
// used to hand-roll both, and every one of them had drifted: a coverless
// name-and-tagline header, an archive dated in the feed's relative voice, a
// single-column masthead, and no route to the subscription terms at all.
//
// AN OUTAGE IS NOT AN EMPTY PUBLICATION. Each loader distinguishes three
// outcomes — loading, loaded (possibly empty), failed — because answering a
// failed fetch with `[]` renders "NO ARTICLES YET" over a full archive, which
// is a confident false claim about somebody else's work. Same rule the public
// pages were fixed to in §0q.8d; this surface is where a MEMBER reads it.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { publications as pubApi } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import { useReader } from "../../stores/reader";
import { useSurfaceOverlay, type PubView } from "../../stores/surfaceOverlay";
import { renderMarkdown } from "../../lib/markdown";
import {
  PublicationMasthead,
  type PubViewName,
} from "./PublicationMasthead";
import { EmptyState, LoadFailed, type PubArticle } from "./article-shared";
import {
  PubArchive,
  PubHomepage,
  PubMastheadList,
  PubSubscribeTerms,
  type MastheadMember,
} from "./pub-sections";

interface PubPublic {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  about: string | null;
  logo_blossom_url: string | null;
  cover_blossom_url: string | null;
  subscription_price_pence: number;
  annual_discount_pct: number;
  isFollowing: boolean;
  /** The writer's chosen homepage template — the overlay honours it, so the
   *  publication reads the same here as on its public page. */
  homepage_layout?: string | null;
}

function Loading() {
  return (
    <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
  );
}

/**
 * A section's own load, as the three outcomes that matter: `null` data while
 * in flight, `failed` for a fetch that did not answer, data otherwise. A hook
 * rather than four copies, because the copies are exactly where the empty-state
 * lie crept in the first time.
 */
function useSection<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, failed };
}

export function PublicationPanel({
  slug,
  view = "home",
}: {
  slug: string;
  view?: PubView;
}) {
  const [pub, setPub] = useState<PubPublic | null>(null);
  const [loading, setLoading] = useState(true);
  // Two different failures, two different things to say: the publication is
  // gone, or we could not reach the gateway. Answering both with "not found"
  // tells a member their colleague's publication has been deleted.
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const openArticle = useReader((s) => s.openNative);
  const openPublication = useSurfaceOverlay((s) => s.openPublication);

  // The masthead (cover/logo/name/tagline/actions/nav) is shared by every view,
  // so we always load the publication record; per-view bodies load their own.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    setFailed(false);
    pubApi
      .getPublic(slug)
      .then((p) => {
        if (!cancelled) setPub(p as PubPublic);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const navigate = useCallback(
    (next: PubViewName) => openPublication(slug, next),
    [openPublication, slug],
  );
  const subscribe = useCallback(
    () => openPublication(slug, "subscribe"),
    [openPublication, slug],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <Loading />
      </div>
    );
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <h1 className="font-sans text-2xl font-medium text-black">
          Publication not found
        </h1>
        <p className="font-sans text-ui-sm text-grey-600 mt-2">
          This publication isn&apos;t available.
        </p>
      </div>
    );
  }

  if (failed || !pub) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <LoadFailed what="this publication" />
      </div>
    );
  }

  return (
    // No horizontal padding on the root: the masthead's cover is full-bleed to
    // the pane's edges, exactly as it is to the viewport's on the public page,
    // and every body below carries its own measure. The top pad is the reader's
    // `pt-2` argument at this surface's scale — it holds the cover clear of the
    // drag grip and the ✕ at rest, so the Glasshouse's `topSeam` stays pure
    // background until the cover is actually scrolled under it.
    <div className="pt-10 pb-12">
      <PublicationMasthead
        pub={pub}
        view={view === "subscribe" ? undefined : view}
        onNavigate={navigate}
        onSubscribe={subscribe}
      />

      <div
        className={`mx-auto px-4 sm:px-6 pt-12 ${
          view === "subscribe" ? "max-w-article" : "max-w-feed"
        }`}
      >
        {view === "home" && (
          <HomeView
            slug={pub.slug}
            layout={pub.homepage_layout}
            onOpen={openArticle}
          />
        )}
        {view === "archive" && (
          <ArchiveView slug={pub.slug} onOpen={openArticle} />
        )}
        {view === "masthead" && <MastheadView slug={pub.slug} />}
        {view === "about" && <AboutView name={pub.name} about={pub.about} />}
        {view === "subscribe" && (
          <PubSubscribeTerms
            name={pub.name}
            monthlyPence={pub.subscription_price_pence ?? 0}
            annualDiscountPct={pub.annual_discount_pct ?? 0}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home — the writer's chosen template, rendered in overlay mode.
//
// THE SAME THREE COMPONENTS THE PUBLIC PAGE USES. This view previously ignored
// `homepage_layout` and rendered a fourth arrangement of its own, so a writer
// who picked Magazine got Magazine on /pub/:slug and something else in the
// workspace. Passing `onOpen` swaps every ArticleLink from a <Link> to a
// <button> that opens the reader in place, which is what keeps the shared
// templates on the right side of the escape ban.
// ---------------------------------------------------------------------------
function HomeView({
  slug,
  layout,
  onOpen,
}: {
  slug: string;
  layout: string | null | undefined;
  onOpen: (dTag: string) => void;
}) {
  const { data, failed } = useSection(
    () => pubApi.getPublicArticles(slug, { limit: 20 }),
    [slug],
  );

  if (failed) return <LoadFailed what="these articles" />;
  if (data === null) return <Loading />;

  return (
    <PubHomepage
      slug={slug}
      layout={layout}
      articles={(data.articles ?? []) as PubArticle[]}
      onOpen={onOpen}
    />
  );
}

// ---------------------------------------------------------------------------
// Archive — the year-grouped index, identical to the public page's. It used to
// be a flat list dated in the feed's relative voice; a publication's archive is
// a record, and a record carries its dates in full.
// ---------------------------------------------------------------------------
function ArchiveView({
  slug,
  onOpen,
}: {
  slug: string;
  onOpen: (dTag: string) => void;
}) {
  const { data, failed } = useSection(
    () => pubApi.getPublicArticles(slug, { limit: 100 }),
    [slug],
  );

  if (failed) return <LoadFailed what="this archive" />;
  if (data === null) return <Loading />;

  const articles = (data.articles ?? []) as PubArticle[];
  if (articles.length === 0) return <EmptyState />;

  return <PubArchive slug={slug} articles={articles} onOpen={onOpen} />;
}

// ---------------------------------------------------------------------------
// Masthead — the team behind the publication. Names open the profile overlay
// (ProfileLink), which supersedes this surface per the one-Glasshouse rule.
// ---------------------------------------------------------------------------
function MastheadView({ slug }: { slug: string }) {
  const { data, failed } = useSection(() => pubApi.getMasthead(slug), [slug]);

  if (failed) return <LoadFailed what="this masthead" />;
  if (data === null) return <Loading />;

  const members = (data.members ?? []) as MastheadMember[];
  if (members.length === 0) {
    return (
      <p className="label-ui text-grey-600 py-16 text-center">
        NO MASTHEAD YET
      </p>
    );
  }

  return <PubMastheadList members={members} />;
}

// ---------------------------------------------------------------------------
// About — the publication's about markdown, rendered client-side via the same
// sanitised pipeline the full-page route uses server-side.
// ---------------------------------------------------------------------------
function AboutView({ name, about }: { name: string; about: string | null }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!about) {
      setHtml("");
      return;
    }
    setHtml(null);
    renderMarkdown(about)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [about]);

  return (
    <div className="max-w-article mx-auto">
      <h2 className="font-sans text-xl font-medium text-black mb-6">
        About {name}
      </h2>
      {html === null ? (
        <Loading />
      ) : html ? (
        <div
          className="prose prose-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="font-sans text-ui-sm text-grey-600">No about page yet.</p>
      )}
    </div>
  );
}
