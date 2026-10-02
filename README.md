# all.haus

A publishing and social reading platform built on Nostr. Writers own their
identity, audience, and content; readers pay across everything they read via
a shared reading tab. Alongside native articles it reads RSS/Atom, external
Nostr, Bluesky, and Mastodon into one workspace.

**https://all.haus**

## Running locally

```
echo "POSTGRES_PASSWORD=password" > .env

docker compose up -d postgres strfry blossom   # schema.sql loads on first boot
# ^ these three only. A bare `docker compose up` fails here: the compose file
# also describes the payment service and nginx, neither of which is mirrored.
# schema.sql is a pg_dump that opens with `\restrict`, so loading it by hand
# needs psql 16.10 or later (the postgres:16 image above is fine).

npm install && (cd web && npm install)   # web is not an npm workspace

DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
  npx tsx shared/src/db/migrate.ts             # seeds platform config defaults

cd gateway && npm run dev          # plus key-service, key-custody, web
```

Copy the `.env.example` in each service directory and fill in generated
secrets.

## What's not mirrored

The Stripe payment service and the migration history live only in the private
repository — `schema.sql` here is the complete, current schema and boots a
fresh database whole. Without the payment service, paid flows (settlement,
payouts) are out of reach; reading, writing, feeds, and auth all run.

The private repository's `scripts/` directory (dev seeding, CI guards, ops
one-offs) is not mirrored either, so the root `npm run seed` / `seed:clean`
and the `knip.json` entries that point at it are not runnable from here.

## Licence

[GNU AGPL v3.0](LICENSE). Run it, study it, modify it — and if you offer a
modified version to others over a network, you must offer them its source too.

## Contributing

This mirror is published from a private development repository; history here
is one commit per release. Issues are welcome; PRs may be cherry-picked
rather than merged. By opening a PR you licence your contribution under
AGPL-3.0.
