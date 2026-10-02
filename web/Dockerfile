FROM node:20-alpine AS build
WORKDIR /app
# Make npm resilient to transient registry resets (ECONNRESET) during parallel builds
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
# Pledge drives + commissioning (parked 2026-07-13). Inlined into the client
# bundle here; default 0 (off). Revive with a rebuild, not just a restart.
ARG NEXT_PUBLIC_PLEDGES_ENABLED
# Tribute system + upstream-edges apparatus (SUSPENDED by operator directive
# 2026-08-25 — reason and restore conditions: docs/adr/LEGAL-BRAKES.md; see
# also docker-compose.yml / shared env.ts). Inlined; default 0 (off).
ARG NEXT_PUBLIC_TRIBUTES_ENABLED
ARG NEXT_PUBLIC_UPSTREAM_EDGES_ENABLED
# Publications — suspended by operator directive 2026-08-31 (reason and restore
# conditions: docs/adr/LEGAL-BRAKES.md; see shared/src/lib/env.ts).
ARG NEXT_PUBLIC_PUBLICATIONS_ENABLED
# Trust graph (parked) and traffology. `web/src/lib/featureFlags.ts` has read
# both since they were written, and NEITHER had an ARG here or a build arg in
# compose — so they were inlined as `undefined` on every build and the two
# features were off with no way for an operator to turn them on. A flag the
# code reads and nothing can set is a dead dial; default 0 (off), which is
# what they have effectively been.
ARG NEXT_PUBLIC_TRUST_ENABLED
ARG NEXT_PUBLIC_TRAFFOLOGY_ENABLED
# next.config.js rewrites() is evaluated at BUILD time and baked into
# .next/routes-manifest.json — so GATEWAY_URL must be present here, not just at
# runtime, or the /api proxy destination falls back to localhost:3000 (which,
# inside the container, is the web service itself → ECONNRESET on every API call).
ARG GATEWAY_URL
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_PLEDGES_ENABLED=$NEXT_PUBLIC_PLEDGES_ENABLED
ENV NEXT_PUBLIC_TRIBUTES_ENABLED=$NEXT_PUBLIC_TRIBUTES_ENABLED
ENV NEXT_PUBLIC_UPSTREAM_EDGES_ENABLED=$NEXT_PUBLIC_UPSTREAM_EDGES_ENABLED
ENV NEXT_PUBLIC_PUBLICATIONS_ENABLED=$NEXT_PUBLIC_PUBLICATIONS_ENABLED
ENV NEXT_PUBLIC_TRUST_ENABLED=$NEXT_PUBLIC_TRUST_ENABLED
ENV NEXT_PUBLIC_TRAFFOLOGY_ENABLED=$NEXT_PUBLIC_TRAFFOLOGY_ENABLED
ENV GATEWAY_URL=$GATEWAY_URL
RUN npm run build

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/package.json /app/next.config.js ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/.next .next
COPY --from=build /app/public public
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["npm", "start"]
