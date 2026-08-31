FROM node:20-alpine AS build
WORKDIR /app
# Make npm resilient to transient registry resets (ECONNRESET) during parallel builds
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/gateway --include-workspace-root
COPY shared/ shared/
COPY gateway/ gateway/
RUN npm run build --workspace=@platform-pub/shared && \
    npm run build --workspace=@platform-pub/gateway

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
RUN npm ci --omit=dev --workspace=@platform-pub/shared --workspace=@platform-pub/gateway --include-workspace-root
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/gateway/dist gateway/dist
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["node", "gateway/dist/index.js"]
