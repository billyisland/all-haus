import { request } from "./client";

// =============================================================================
// Upstream Edges API (credit / citation / dispute)
//
// Spec: docs/adr/UPSTREAM-EDGES-ADR.md. Phase 1 read endpoints keyed on the
// internal articles.id UUID (the reader's `articleDbId` prop, NOT the nostr
// event id).
// =============================================================================

export interface CreditDisclaimer {
  id: string;
  /** True ⇒ filed by the credited party themselves (a real disclaimer). */
  byCreditedParty: boolean;
  counterCharacterisation: string;
  createdAt: string;
}

/** The signed-in viewer's own (non-withdrawn) dispute against an edge. */
export interface ViewerDispute {
  id: string;
  counterCharacterisation: string;
  /** True ⇒ the viewer is the cited/credited party (no stake held). */
  byCitedAuthor: boolean;
  /** True ⇒ a refundable £5 stake is held on the viewer's tab. */
  staked: boolean;
}

export interface CreditEdge {
  id: string;
  target: {
    /** NULL ⇒ native/unaddressable; else the external protocol. */
    protocol: string | null;
    externalId: string | null;
    displayName: string | null;
    /** Set when the credited source is a native member. */
    accountId: string | null;
    username: string | null;
  };
  note: string | null;
  createdAt: string;
  disclaimers: CreditDisclaimer[];
  /** The viewer's own dispute against this credit, if any (auth only). */
  mine: ViewerDispute | null;
}

export interface CitationDispute {
  id: string;
  counterCharacterisation: string;
  widerExcerpt: string | null;
  createdAt: string;
}

export interface CitationEdge {
  id: string;
  source: {
    protocol: string | null;
    authorPubkey: string | null;
    naddr: string | null;
    uri: string | null;
    username: string | null;
    displayName: string | null;
  };
  excerpt: string;
  charStart: number | null;
  charEnd: number | null;
  characterisation: string;
  createdAt: string;
  disputes: {
    /** The cited author's own dispute (max one, rendered inline). */
    citedAuthor: CitationDispute | null;
    /** Third-party disputes are a count only — never glance-level badges. */
    thirdPartyCount: number;
    /** The viewer's own dispute against this citation, if any (auth only). */
    mine: ViewerDispute | null;
  };
}

export interface CreateCreditInput {
  articleId: string;
  /** Omnivorous identifier — username / npub / DID / handle / URL / free label. */
  target: string;
  note?: string;
}

export interface CreateCitationInput {
  articleId: string;
  /** Omnivorous identifier of the cited source. */
  source: string;
  /** The passage being cited (the integrity anchor — hashed server-side). */
  excerpt: string;
  /** The author's claim about the source ("X argues Y"). */
  characterisation: string;
  charStart?: number;
  charEnd?: number;
}

export interface FileDisputeInput {
  /** Exactly one of these identifies the disputed edge. */
  citationEdgeId?: string;
  creditEdgeId?: string;
  counterCharacterisation: string;
  /** Fuller surrounding context (citations only). */
  widerExcerpt?: string;
}

export const upstreamEdges = {
  getCredits: (articleId: string) =>
    request<{ credits: CreditEdge[] }>(`/articles/${articleId}/credits`),
  getCitations: (articleId: string) =>
    request<{ citations: CitationEdge[] }>(`/articles/${articleId}/citations`),

  createCredit: (input: CreateCreditInput) =>
    request<{ id: string }>(`/credits`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createCitation: (input: CreateCitationInput) =>
    request<{ id: string }>(`/citations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  fileDispute: (input: FileDisputeInput) =>
    request<{ id: string; staked: boolean }>(`/disputes`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  withdrawDispute: (id: string) =>
    request<{ ok: true }>(`/disputes/${id}`, { method: "DELETE" }),
};

/** Client-side dark flag — mirrors the gateway's UPSTREAM_EDGES_ENABLED
 *  (suspended 2026-08-25 with the tribute system by operator directive; the
 *  routes 404 when off). Hides the article-foot apparatus and the author's
 *  Cite affordance. */
export function upstreamEdgesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_UPSTREAM_EDGES_ENABLED === "1";
}
