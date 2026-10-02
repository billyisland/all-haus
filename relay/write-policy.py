#!/usr/bin/env python3
"""
strfry write policy for all.haus — writes come from INSIDE.

WHAT THIS CLOSES (MIRROR-AUDIT §3 *Security*, S16; DEEP-AUDIT-2026-07-16 M23).
`relay/strfry.conf` carried no `writePolicy` block at all, so the default —
accept everything — applied, and nginx proxies `/relay` to this relay as a
WebSocket upgrade from the public internet. Anyone could publish any event of
any kind into our LMDB, toward its 8 GB cap, and have it served back to readers
alongside our authors' work. The loopback port bind fixed in 2026-07-16 did not
touch this: it closed the raw port, and `wss://all.haus/relay` was never the raw
port.

THE RULE, AND WHY IT IS THIS ONE. Every event the platform itself publishes is
handed to `ws://strfry:7777` directly over the compose network — the relay-outbox
worker and the outbound publisher both read `PLATFORM_RELAY_WS_URL`, which
docker-compose sets to exactly that, and neither has ever gone through nginx. So
there is no legitimate write from the public side, and the discriminator is
simply WHICH SIDE the connection came from.

That is only a usable discriminator because `relay.realIpHeader` is set (see
strfry.conf): with it, a connection arriving through nginx reports the browser's
real address, because nginx overwrites `X-Real-IP` with `$remote_addr` on every
proxied request and a client cannot forge past that. A connection made directly
to `strfry:7777` sends no such header and reports its compose-network address.
So "private address" means "did not come from the internet", and a public client
that invents an `X-Real-IP` of `172.18.0.9` still cannot use it: nginx replaces
the header before strfry ever sees it.

WHY NOT A PUBKEY ALLOWLIST. That was the shape the tracker first proposed, and
it is strictly weaker here for two reasons. It would need this process to reach
the database to know which custodial pubkeys exist — a DB client inside the relay
container, kept in sync, failing closed on every publish when it stalls. And it
would still accept a captured, replayed event from the public side, because a
signature is not a session. The connection-origin rule needs no state, cannot go
stale, and refuses the replay too.

WHAT STILL WORKS. `strfry import` / `stream` / `sync` report a non-IP
`sourceType`, so the operator's own recovery path — the one that recovered 22
abandoned outbox rows on 2026-07-16 — is unaffected and is listed explicitly
rather than falling through some default. Reads are untouched: a write policy
sees only writes, so the public relay stays fully readable, which is the whole
reason it is exposed.

FAIL CLOSED, AND SAY SO. A malformed line, an unknown source type, an
unparseable address: reject. A plugin that crashes takes the relay's writes with
it, so every branch answers; a plugin that guessed would be a plugin whose
silence you could not tell from its consent. Rejections carry NIP-01's
`blocked:` prefix, which our own outbound classifier reads as terminal — correct,
because this IS a deterministic refusal and retrying it would burn a row's whole
retry budget against a decision that will not change.
"""

import ipaddress
import json
import sys

# strfry reports these for events that did not arrive over a client socket:
# the operator's own `strfry import`, a `router`/`stream` pull from a peer, and
# `sync`. None of them is reachable from the internet.
NON_SOCKET_SOURCES = {"Import", "Stream", "Sync"}


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def respond(event_id, action, msg=None):
    out = {"id": event_id, "action": action}
    if msg:
        out["msg"] = msg
    print(json.dumps(out, separators=(",", ":")), end="\n", flush=True)


# The address ranges a peer can hold when it is a container on the compose
# network, another process on the host, or the host itself. Written out rather
# than expressed as `ipaddress.is_private`, which is a WIDER predicate than this
# one: Python counts the RFC 5737 documentation ranges, CGNAT (100.64/10), 6to4
# relay space and several other non-globally-reachable blocks as "private" too.
# None of those is our compose network, and a rule that accepts writes from
# addresses it cannot explain is not a rule. (Not academic — the first live probe
# of this policy used 203.0.113.7 as a stand-in for a public client and was
# ACCEPTED, because that is TEST-NET-3.)
INTERNAL_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),        # RFC 1918
    ipaddress.ip_network("172.16.0.0/12"),     # RFC 1918 — docker's default pool
    ipaddress.ip_network("192.168.0.0/16"),    # RFC 1918
    ipaddress.ip_network("127.0.0.0/8"),       # loopback
    ipaddress.ip_network("169.254.0.0/16"),    # link-local
    ipaddress.ip_network("::1/128"),           # loopback (v6)
    ipaddress.ip_network("fc00::/7"),          # unique local (v6)
    ipaddress.ip_network("fe80::/10"),         # link-local (v6)
]


def is_internal(source_info):
    """True when the peer address is one strfry could only have been handed from
    inside the compose network, from the host, or from the operator's own shell.

    Everything else — including anything we cannot parse as an address at all —
    is treated as the public side and refused."""
    try:
        addr = ipaddress.ip_address(str(source_info).strip())
    except ValueError:
        # Not an address we can reason about — refuse rather than guess.
        return False
    return any(addr in net for net in INTERNAL_NETWORKS)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            eprint("write-policy: unparseable input line")
            continue

        # `lookback` replays events strfry already holds so a stateful plugin can
        # rebuild; we hold no state, and it expects no response.
        if req.get("type") == "lookback":
            continue
        if req.get("type") != "new":
            eprint("write-policy: unexpected request type %r" % req.get("type"))
            continue

        event_id = (req.get("event") or {}).get("id")
        if not event_id:
            eprint("write-policy: input with no event id")
            continue

        source_type = req.get("sourceType")
        if source_type in NON_SOCKET_SOURCES:
            respond(event_id, "accept")
            continue

        if is_internal(req.get("sourceInfo")):
            respond(event_id, "accept")
            continue

        respond(
            event_id,
            "reject",
            "blocked: this relay accepts writes from the platform only",
        )


if __name__ == "__main__":
    main()
