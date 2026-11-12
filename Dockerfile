# ---- production image: small, non-root, healthchecked ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/taskflow.db
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Persistent SQLite lives in /data (mount a volume here).
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server/index.js"]
