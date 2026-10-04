# Builds both images from one context so the npm workspace lockfile is shared.
#   docker build --target server -t failover-controller-server .
#   docker build --target web    -t failover-controller-web .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

FROM node:22-bookworm-slim AS server
# iputils-ping: ICMP health checks; tini: signal handling so a running failover can finish on stop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist server/dist
WORKDIR /app/server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80 443
