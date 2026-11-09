# Chytai web platform. Built from the repo root (fly.toml in web/ points here; flyctl -c web/fly.toml).
FROM node:22-slim

WORKDIR /app
# vipsthumbnail makes the covers' small copies (thumbs.js).
RUN apt-get update && apt-get install -y --no-install-recommends libvips-tools && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY web ./web
# The read-only production view for threads (server/agent.js), shared with the reader.
COPY server/agent.js ./server/agent.js
# The commit, for /agent/health (web.yml passes it).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
COPY build/icon.png ./build/icon.png

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "web/main.js"]
