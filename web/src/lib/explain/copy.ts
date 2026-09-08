// =============================================================================
// Explain copy — EVERY caption the Explain engine renders, in one file.
//
// This file is prose only: no engine logic, no ordering, no DOM. Edit any
// string here at will; nothing else needs to change. The engine machinery
// (the ExplainKind union, sequence ordering, program builders) lives in
// ./registry.ts, which imports this file. The type annotations are the safety
// net: deleting or misnaming a caption fails the build instead of silently
// rendering nothing.
//
// Editorial voice (revised 2026-07): plain-spoken and conversational.
// Contractions and direct address are fine; a caption names what a thing is
// and what happens when you touch it, rather than teaching the model behind
// it. Repeated gestures still share grammar (A.4 notes inline). EXPLAIN-ADR
// Appendix A is the historical editorial record; this file is what the engine
// actually reads.
// =============================================================================

import type { CardFlavour, ExplainKind } from "./registry";

// ---------------------------------------------------------------------------
// Explain-program labels — Appendix A.2 / A.3.
//
// `vessel` forks on starter provenance (D7), so it is NOT in this record; its
// two variants are VESSEL_COPY below. `card` here is the FALLBACK card label —
// cards with a recognised flavour render CARD_FLAVOUR_COPY instead.
// ---------------------------------------------------------------------------

export const EXPLAIN_LABELS: Record<Exclude<ExplainKind, "vessel">, string> = {
  floor:
    "Fill this space with feeds. You can have as many as you want, configured and positioned however suits you. They stay where you put them.",
  // disc annotates the REAL ∀ disc (D3, 2026-07-15 form: only the wordmark
  // gives way to the About button, so the disc stays on screen and is
  // described as itself).
  disc:
    "This is the ∀ menu. Aside from individual feed settings, everything runs from here. (Right now, clicking it just turns off Explain mode).",
  about:
    "This opens all.haus's About page.",
  // NAV-ROW-MUSTER-ADR §VII. Names the three states without teaching the
  // virtualization behind them, and says the one thing to do with it. Rewritten
  // 2026-08-31 with the states themselves (Muster.tsx "THREE STATES, ONE RAMP")
  // — the hollow ring it used to name no longer exists, and grey moved from
  // minimised to off-screen, so every clause of the old wording was wrong.
  "navRow.muster":
    "One roundel per feed, in numbered order. A big one is a feed you can see right now; a smaller grey one is off to the side. A crossed-out one is minimised. Click any of them to go straight to the feed it represents.",
  pane: "This is a pane, floating over your workspace. Drag it to move it and it will remember where you put it. Close it by clicking outside or on the x, or by pressing Escape.",
  // First sentence deliberately echoes vessel.resize: same grammar for the
  // same gesture (Appendix A.4 harmonisation note).
  "pane.resize":
    "Drag this corner to make the pane bigger or smaller.",
  "pane.frame":
    "This frame takes its colour from the feed you opened it from, so you can see at a glance where it came from.",
  "pane.ear.prev":
    "This steps back to the previous article in the feed you came from. The ← key does the same.",
  // The ↑/↓ hint lives on this ear only, so the pair never repeats it verbatim.
  "pane.ear.next":
    "This steps forward to the next article in the feed you came from. The → key does the same, and ↑ and ↓ scroll the page as you read.",
  reader:
    "This is the reader pane: anything you open from a feed displays here.",
  "reader.bar":
    "Dragging the bar moves the pane.",
  "reader.barSource":
    "This names where the piece came from \u2014 the feed or account you subscribed to, as distinct from who wrote this particular item. Click it to open that source\u2019s own page here.",
  "reader.barTitle":
    "This is the title of what you are reading. Click it to open the piece at its own address, in a new tab \u2014 the original site for anything from elsewhere, and the public all.haus page for anything published here.",
  "reader.gate":
    "This is a paywall. Click through it and the charge goes on your tab, which you can find in the ∀ menu under 'Ledger'.",
  composer:
    "This is for writing notes: short posts published to anyone who follows your all.haus account. If you want to write something longer, click 'Make this an article'.",
  "composer.crosspost":
    "One switch per network you have connected to your all.haus account: dark means this note will also post there. The default for each network is set in Settings, under Reach other networks.",
  "composer.article":
    "Turn what you're writing into a full article. Articles have no upper word limit. They can take a title, a standfirst, images, tags and a paywall.",
  editor:
    "This is the article editor, for writing something more substantial than a note. Your draft saves itself while you work.",
  "editor.dek":
    "This is the standfirst: one line under the title saying what your piece is about. It also displays on the article's title card in feeds. If you leave this field blank, the title card will preview your article's opening line.",
  "editor.paywall":
    "This drops a paywall into the article at any place you want. Everything above the line is free; everything below it is paid. Click again to take it out.",
  "editor.gate":
    "This is where the free part of the article ends. Readers pay to keep going.",
  "editor.price":
    "This is what a reader pays to cross the paywall. Based on length, all.haus suggests a default price, but you can charge whatever you want.",
  "editor.tags":
    "Tags say what the piece is about. To follow everything that is published on all.haus under a given tag, you can add that tag as a source to one of your feeds.",
  "editor.schedule":
    "This delays publication to a time you choose. A scheduled piece waits in your dashboard and publishes automatically at the time you selected.",
  "editor.draft":
    "Saving happens by itself as you write; this button saves on demand. Drafts are saved in your dashboard, under the ∀ menu.",
  "editor.publication":
    "This chooses who the article goes out as: you, or a publication you belong to. Depending on your role there, a publication piece might need an editor's approval before it goes live.",
  feedComposer:
    "This is the feed composer, where you can customise each feed individually: its name, its sources and their volumes, how it looks, and where it sits in your feed list.",
  "feedComposer.addSource":
    "Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Paste whatever you have - a username, a URL, an npub or a #tag - and all.haus works it out.",
  "feedComposer.source":
    "This is one of the feed's sources. Click its name to look at it; the × at the end of the row removes it from this feed.",
  "feedComposer.volume":
    "This is the source's volume in this feed: quieter to the left, louder to the right. The × in front mutes it without removing it. When it's turned down, RANDOM and TOP decide which of its posts get through, and NO REPLIES shows you only its freestanding posts.",
  "feedComposer.colour":
    "Select a colour scheme for this feed. (Light or dark mode follows your sitewide appearance setting.)",
  "feedComposer.view":
    "Select how much of each post this feed shows.",
  "feedComposer.orientation":
    "Switch this feed between vertical and horizontal mode.",
  "feedComposer.textSize":
    "Set the text size for this feed only. (The control for sitewide text size is in Settings.)",
  "feedComposer.order":
    "Drag the rows to put your feeds in order. These numbers are the ones the feeds show on the floor, and on a phone it's the order you swipe through.",
  // Verbatim reuse of vessel.hide: one grammar for one gesture (Appendix A.4).
  "feedComposer.hide":
    "This hides the feed without destroying it. Restore a hidden one from the top navigation bar at any time.",
  "feedComposer.delete":
    "This deletes the feed for good. If you only want it out of the way, hide it instead.",
  // --- C3: destination surfaces (Appendix A.3d) ---
  messages:
    "This is your inbox, in three parts: notifications on the left, your conversations in the middle, and the open conversation on the right. Everything addressed to you lands somewhere here.",
  "messages.notifications":
    "This is your activity log, recording follows, replies, quotes, mentions and new subscribers. Click a row to see what it's about; a message notification opens the conversation right here.",
  // Echoes the omnivorous grammar of feedComposer.addSource ("whatever you
  // have"): one grammar for one gesture (A.4).
  "messages.new":
    "This starts a conversation. Address it with whatever you have: a username, an email address, an npub.",
  "messages.thread":
    "This is the open conversation. Write at the bottom; click on any message to like it or answer it directly. Older messages load from the top.",
  dashboard:
    "This is your dashboard: what you've written, who subscribes to you, what your work earns and what it costs to read. The money itself is tracked in the Ledger; this is where you run the writing.",
  "dashboard.context":
    "Dashboards come one per identity: your own, and one for each publication you belong to. Switch here, or start a new publication.",
  "dashboard.articles":
    "Drafts and published pieces share this table, drafts first. Schedule a draft and it publishes itself at the time you set. Replies turns a piece's comment thread on or off.",
  "dashboard.gifts":
    "This makes gift links for a paywalled piece: anyone opening one reads it free. Each link carries a set number of uses and can be revoked.",
  "dashboard.pricing":
    "Set your prices here: the cost of a monthly subscription, and the default price of a paywalled article (scaling with length, or fixed). To actually get paid, connect Stripe.",
  // Two logs, and the pair only explains itself if both captions say what
  // theirs holds and what it does NOT. Recent reading is the whole web and
  // forgets; the library is ours alone and keeps.
  library:
    "Two logs. Recent reading is everything you've opened lately, from anywhere. The library is everything you've got from all.haus. Anything in either opens straight back into the reader.",
  "library.recent":
    "Everything you've opened in a reader over the last week — all.haus or anywhere else, paid or free, most recent first. It clears itself as things age out, and you can empty it or switch it off in Settings.",
  "library.holdings":
    "Every all.haus piece you've got, newest first — including the ones your free allowance covered. It keeps for as long as your account does. What the paid ones cost you is in the Ledger.",
  network:
    "This is your network: who you follow, who follows you, and the accounts you've blocked or muted.",
  "network.dmFee":
    "This puts a price on messages from people you don't follow: set one, and a stranger pays it to reach you. Leave it blank and anyone can write for free. Overrides give particular people a different price, or none.",
  // Teaches the feed-derived external-follow invariant from the reader's side.
  "network.following":
    "Writers you follow on all.haus. Following someone from another network works differently: you add them to one of your feeds, and that's where the following lives.",
  "network.blocked":
    "Accounts you've blocked: they disappear from your feeds and can't reply to your work. Unblock them here.",
  "network.muted":
    "Accounts you've muted: you stop seeing them, and they're not told. To also stop someone replying to you, block them instead.",
  // Carries the Ed-approved "this is your reading tab" sentence (C3 scope).
  ledger:
    "This is your ledger, which records everything your account earns and spends, to the penny. The reading tab settles periodically in one charge, not every time you read an article.",
  "ledger.balance":
    "One figure for the whole account: what you've earned minus what you've spent. In credit, it's yours; if you owe, it settles from your card once the tab reaches its threshold.",
  "ledger.allowance":
    "This is your free allowance. Charges only start landing on the tab once you've spent it.",
  "ledger.transactions":
    "This records all your reads, settlements, subscriptions, and earnings. Filter by direction, or hide the free reads.",
  "ledger.subscriptions":
    "Your active subscriptions. For each one, you decide whether new pieces are sent to your email, whether the subscription shows up on your profile, and whether to cancel it (which keeps your access until the period ends).",
  settings:
    "These are your account settings: who you are, how you pay and get paid, how far your words travel, and this device's preferences. Anything about a particular feed lives in that feed's composer panel instead.",
  "settings.payment":
    "The card on file settles your reading tab and pays for subscriptions. Stripe Connect is the other direction: it's how your earnings reach your bank.",
  "settings.discovery":
    "This is your permission for all.haus to publish you to the open Nostr network: your profile and where to read you, so people anywhere can find and follow you. Private withdraws it.",
  // Reciprocates composer.crosspost ("The default for each network is set in
  // Settings, under Reach other networks").
  "settings.reach":
    "Networks you've linked, and what each can do: whether your notes crosspost there by default, and whether the people you follow there can be pulled into your feeds. The composer's per-note switches start from these defaults.",
  "settings.theme":
    "Light or dark mode for the whole site, on this device. 'System' follows your machine's settings.",
  // Reciprocates feedComposer.textSize ("the sitewide type size lives in
  // Settings").
  "settings.typeSize":
    "This sets all.haus's type size on this device. You can fine-tune the type size of individual feeds, too, in the feed composer.",
  "settings.export":
    "This downloads everything that's yours: your keys, your writing, your receipts. Using your cryptographic keys, you can take your identity and your audience anywhere on the open Nostr network, not just all.haus.",
  // --- C4: profile + surface overlays (Appendix A.3e) ---
  profile:
    "This is a profile page. It tells you much the same stuff whether it's for an all.haus account or an account on another network: who this is, what they've posted, and various ways to follow them.",
  "profile.follow":
    "This follows the writer: everyone you follow is listed under Network in the ∀ menu. Their posts arrive by feed — add them to one as a source, and the Follow button on a feed card does both at once for the feed you're in.",
  // Teaches the feed-derived external-follow invariant from the doer's side,
  // reciprocating network.following (A.4).
  "profile.followFeeds":
    "This follows someone from another network, which works by feed: pick which of your feeds should carry their posts, or start a new one for them. To follow someone you need to have them in at least one of your feeds.",
  "profile.handle":
    "Click to open their profile on their home network, in a new tab.",
  // On a profile FOR someone on another network, the name and the handle both
  // lead out. Each caption names its own destination rather than pointing at
  // the other: whichever one you hover is the one you were about to click, and
  // a caption that defers to its sibling answers a question you did not ask.
  // That link replaced the "VIA BLUESKY" strap the bar used to carry:
  // a reader who wants the origin network wants to go there, not be told its
  // name (web/CLAUDE.md › Profile chassis).
  "profile.name":
    "This is their name on their home network, and clicking it opens their profile there in a new tab.",
  // Money site (Ed-approved 2026-07-16). One kind for both states: the copy
  // reads for Subscribe and for Subscribed/cancel alike.
  "profile.subscribe":
    "Subscribe to the writer, monthly or yearly: while your subscription is in effect, their paywalled pieces cost nothing extra to read. Manage your subscriptions from the Ledger.",
  // D6: a byline inside a feed has no profile of its own on any network — this
  // page is the log of what they wrote IN that source, and the source is what
  // you can follow. Same inward routing as the card's provenance line.
  "profile.writingIn":
    "This author is known here only through what they write in this source — there's no profile of theirs anywhere else for all.haus to show. Click the source's name to open its own page here, with everything it has published; to follow, follow the source.",
  "profile.identityLinks":
    "If the same person posts from more than one place, link their accounts here. Your feeds then treat those accounts as one person, and a piece posted to several networks shows only once.",
  // The ALSO KNOWN AS row. Its three tier words (VERIFIED / DETECTED / YOU
  // LINKED) are the whole content of the annotation: they are opaque on the
  // screen, and they differ in WHO is making the claim.
  "profile.identityRow":
    "Other places this account posts, and how each connection is known: verified means they proved it themselves, detected means all.haus worked it out, and you linked means you said so.",
  source:
    "This is a summary page for a source: what it publishes, newest first, as far back as all.haus has seen. To follow this source, add it to one of your feeds.",
  // Second sentence deliberately reciprocates editor.tags (A.4).
  tag: "This is the summary page for a topic tag, where all.haus collects every article published under that tag. If you're particularly interested in this topic, you can add it to a feed as a source.",
  pub: "This is a publication: writers publishing together under one name, with a masthead, an archive and followers of its own.",
  "pub.nav":
    "These are the publication's pages: its latest pieces, what it is, who makes it, and everything it's published. Each opens here in place.",
  "pub.follow":
    "This follows the publication: its new pieces arrive by email until you say otherwise. To see it in your workspace, add the publication to a feed as a source.",
  "vessel.name":
    "This is the feed's name. Click to rename it and manage its sources, or click and drag to move the feed around your workspace.",
  "vessel.gear":
    "Access each feed's individual settings via this button: renaming, appearance, the full list of sources, and deletion.",
  "vessel.hide":
    "This hides the feed without destroying it. Restore a hidden one from the top navigation bar at any time.",
  "vessel.addSource":
    "Type here to add a source: a social media account, a blog, a newsletter, a tag, anything.",
  "vessel.resize": "Drag this corner to make the feed bigger or smaller.",
  // Fallback card label: renders only when a card carries no recognised
  // flavour (see CARD_FLAVOUR_COPY below).
  card: "One item from one of this feed's sources, presented in chronological order.",
  "card.byline":
    "Hover over the name to follow this person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.",
  // BYLINE-AND-PROVENANCE-ADR D7: the byline is who wrote it; this line is
  // what you subscribed to. The name goes to the source's own page here; the
  // arrow is the one route out.
  "card.originSource":
    "This names where the item came from — the feed or account you subscribed to, as distinct from who wrote it. Click the name to open that source's own page here, with everything it has published and a way to follow it.",
  "card.originLink":
    "This arrow opens the original, on the site it came from, in a new tab. It's the one place on a card that leaves all.haus.",
  // D8: the native card's counterpart to card.originSource — an article's
  // publication is the thing a reader subscribed to, where that isn't the
  // writer. Same slot, same inward routing, no arrow (all.haus is the origin).
  "card.originPublication":
    "This names the publication this article was published in, as distinct from who wrote it. Click the name to open the publication here \u2014 its masthead, its archive, and a way to follow or subscribe.",
  // D7 resonance glyph. Names what the dots measure without teaching the
  // model behind them, and says the thing people will otherwise assume it is:
  // not a popularity count, and nothing to do with money.
  "card.resonance":
    "These dots mean a post is getting an unusual amount of response \u2014 measured against what this author usually gets, not against everyone else. One dot is noticed, three is surging. It's not a popularity score, and nothing to do with money.",
  "card.reply":
    "This posts a reply, which appears in the thread underneath the original.",
  "card.quote":
    "This quotes the item into a post of your own, so you can add your thoughts on top. The original stays attached and attributed.",
};

// ---------------------------------------------------------------------------
// Card flavours — the per-kind-of-card variants of the `card` label
// (2026-07-16, third-session amendment). The flavour is derived from the
// post's origin (registry.ts::explainCardFlavour) and carried on the card as
// `data-explain-param`; a card with no recognised flavour falls back to
// EXPLAIN_LABELS.card above.
// ---------------------------------------------------------------------------

export const CARD_FLAVOUR_COPY: Record<CardFlavour, string> = {
  "native-article":
    "This is an article from an all.haus account. Click on the card and the piece opens in the reader.",
  "native-note":
    "This is a note from an all.haus account. Click it to open the conversation around it.",
  nostr:
    "This is a Nostr post from the open network beyond all.haus.",
  atproto:
    "This is a Bluesky post.",
  activitypub:
    "This is a post from the Fediverse, Mastodon and its relatives.",
  rss: "This is an item from an RSS feed.",
  email:
    "This is an email newsletter, caught by the feed and read here instead of in your inbox.",
};

// ---------------------------------------------------------------------------
// The vessel label — forks on starter provenance (D7): the Billy Island copy
// renders only on the actual starter clone.
// ---------------------------------------------------------------------------

export const VESSEL_COPY = {
  starter:
    "A feed is a list of sources plus the weights you've given them. To get you started, this one's copied from a feed belonging to Billy Island, founder of all.haus. For better or worse, it reflects his interests. Change what's in it, or delete it and start fresh.",
  neutral:
    "A feed is a list of sources plus the weights you've given them. Change what's in it, or delete it and start fresh.",
} as const;

// ---------------------------------------------------------------------------
// First-run program copy — Appendix A.1, six beats, verbatim. The beat
// STRUCTURE (anchors, floats, the done affordance) lives in
// registry.ts::firstRunBeats; only the prose is here.
// ---------------------------------------------------------------------------

export const FIRST_RUN_COPY = {
  vesselStarter:
    "This is a feed: a list of sources plus the weights you have given them. This one is copied from a feed belonging to Billy Island, founder of all.haus, and for better or worse it reflects his interests. It's yours now. Change it or delete it as you see fit.",
  vesselNeutral:
    "This is a feed: a list of sources plus the weights you have given them. It's yours to change or delete as you see fit.",
  addSource:
    "You can add a source here: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Everything arrives in one place and reads the same way, so you don't need a separate app for each.",
  byline:
    "Hover over a name to follow that person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.",
  disc: "This is the ∀ menu. Everything runs from here: writing, searching, your messages, your money, your global settings. Next to it, About has an account of what all.haus is and how it works.",
  floor:
    "Make as many feeds as you like and arrange them however suits you. They stay where you put them.",
  // SHOWN ONLY TO SOMEONE WHO ARRIVED FROM A PIECE, and the gate is the READING
  // LOG — `readingLog.list(1)`, not the library and not `read_events`.
  //
  // THE PATH C REASONING RUNS THE OTHER WAY NOW, AND THIS COMMENT IS ITS
  // REPLACEMENT rather than its survivor (READING-LOG-AND-LIBRARY-ADR §8.1).
  // It used to say the gate counted `read_events` rather than arrival records,
  // because an above-cap arrival (PAYWALL-ARRIVAL D4 Path C) is recorded but
  // never unlocked — "there is nothing in the Library to point at". Against
  // Recent reading that argues the opposite: a Path C reader WAS reading the
  // piece, above the gate, and Recent reading is a log of attention rather
  // than possession. So they belong in it, the sentence is true for them, and
  // the old comment — left in place — would have argued for a gate excluding
  // exactly the readers it should include. A comment that survives the
  // decision it justified is worse than no comment.
  //
  // The beat therefore fires for EVERY arrival, with no special case: every
  // arrival path lands the reader back on the piece logged in with a reader
  // mounted, and the log write hangs off that mount rather than off the unlock
  // (ADR §8.3). That is the whole of why the write is on mount.
  //
  // THIS IS PAYWALL-ARRIVAL D6, RE-HOUSED. It was the welcome sheet's Library
  // step, and it was orphaned when that sheet was deleted (ADR §13.3) — the
  // mechanism intact and nobody mentioning it. A tour beat is the better home
  // anyway: D6's complaint was that a newcomer has no reason to open a menu
  // they have never seen, and the beat before this one is the beat that
  // introduces the menu.
  library:
    "You can find the piece you were just reading under Recent reading, in the Library on the ∀ menu.",
  // THE LAST BEAT NAMES ITS OWN DOOR. Everything before it explains a thing the
  // member is looking at; this one explains the house, and then says how to get
  // another note like it — which is load-bearing rather than a sign-off, since
  // Explain is strictly ∀-menu-invoked (the auto-entry `FirstRunController` is
  // dormant by decision: landing in Explain mode unasked "read as a
  // malfunction, not a welcome"). A tour that ends without naming the menu
  // leaves the whole apparatus undiscoverable.
  finale:
    "There is no algorithm. Your feeds run in chronological order, weighted by you. Anything you publish using all.haus lives on an open protocol and remains yours whether or not you make your home here. The public square shouldn't have a landlord.\n\nIf you're ever puzzled by part of our interface, select Explain from the ∀ menu to see more explanatory notes like this.",
} as const;
