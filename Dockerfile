# Server build & runtime for the full local-first Mail Collector service.
# Used to deploy this app on a host where the browser/web interface is served
# from the same Node process that talks to IMAP/SMTP.

FROM stokaro/ptah:0.12.0@sha256:fdf9c7009018a6cd3954c43f986d8b283c35255ed468c98eb4317529be19928c AS ptah

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:server && npm run build:web && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/mail-collector.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
COPY --from=build /app/migrations ./migrations
COPY --from=ptah /usr/local/bin/ptah /usr/local/bin/ptah
COPY --from=ptah /usr/share/licenses/ptah/LICENSE /usr/share/licenses/ptah/LICENSE
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
