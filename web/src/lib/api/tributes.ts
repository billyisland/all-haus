import { request } from "./client";

// =============================================================================
// Tributes API (Upstream Edges Phase 2 — the money edge, authoring + contact)
//
// Spec: docs/adr/UPSTREAM-EDGES-ADR.md. Ships dark behind TRIBUTES_ENABLED on
// the gateway (routes 404 when off) and NEXT_PUBLIC_TRIBUTES_ENABLED on the web
// (the authoring/consent UI is hidden when off). Phase 2 moves NO money.
// =============================================================================

export interface TributeView {
  id: string;
  percentageBps: number;
  /** proposed | live | declined | lapsed. */
  status: string;
  /** False ⇒ accruing-and-held with no contactable payee (shown honestly). */
  reachable: boolean;
  target: {
    protocol: string | null;
    externalId: string | null;
    displayName: string | null;
    /** Set when the inspirer is a native member. */
    accountId: string | null;
    username: string | null;
  };
  /** Phase-4 composition: the citation this tribute was offered from, if any. */
  citationEdgeId: string | null;
  /** Phase-5 chains: NULL ⇒ a root tribute (carves the piece net); non-NULL ⇒ a
   *  child of that tribute (redirects a share of the parent's slice upstream). */
  parentTributeId: string | null;
  /** 0 for roots, parent.depth + 1 for children — the tree level. */
  depth: number;
  /** True ⇒ the viewer authored this tribute (can withdraw a proposed one). */
  mine: boolean;
  createdAt: string;
}

export interface IncomingOffer {
  id: string;
  percentageBps: number;
  status: string;
  articleId: string;
  articleTitle: string;
  /** The native article d-tag — link to /article/:dTag to read the piece. */
  articleDTag: string;
  author: { username: string | null; displayName: string | null };
  createdAt: string;
}

export interface CreateTributeInput {
  articleId: string;
  /** Share of the piece's writer-side net, in basis points (1–10000). */
  percentageBps: number;
  /** Omnivorous identifier of the inspirer — username / npub / handle / URL / label. */
  target: string;
  /** Always collected up front (the oracle-close); ignored for a known member. */
  inviteEmail?: string;
  note?: string;
  /** Phase-4 composition: offer this tribute FROM a citation on the same piece. */
  citationEdgeId?: string;
  /** Phase-5 chains: redirect a share of this PARENT tribute's slice upstream.
   *  The offerer must be the parent's live beneficiary (C1). */
  parentTributeId?: string;
}

export const tributes = {
  getForArticle: (articleId: string) =>
    request<{ tributes: TributeView[] }>(`/articles/${articleId}/tributes`),
  mine: () => request<{ offers: IncomingOffer[] }>(`/tributes/mine`),

  create: (input: CreateTributeInput) =>
    request<{ id: string; status: string }>(`/tributes`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  consent: (id: string) =>
    // articleId/percentageBps returned so the client can open the upstream child
    // composer ("Accept & pass a share upstream", Phase-5 C1).
    request<{ ok: true; status: string; articleId: string; percentageBps: number }>(
      `/tributes/${id}/consent`,
      { method: "POST" },
    ),
  decline: (id: string) =>
    request<{ ok: true; status: string }>(`/tributes/${id}/decline`, { method: "POST" }),
  withdraw: (id: string) =>
    request<{ ok: true }>(`/tributes/${id}`, { method: "DELETE" }),
  /** Bind the signed-in account to an external email invite. */
  claim: (token: string) =>
    request<{ id: string; articleId: string; articleDTag: string }>(`/tributes/claim`, {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
};

/** Client-side dark flag — mirrors the gateway's TRIBUTES_ENABLED. */
export function tributesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRIBUTES_ENABLED === "1";
}
