# Chytai web platform. Built from the repo root (fly.toml in web/ points here; flyctl -c web/fly.toml).
FROM node:22-slim

WORKDIR /app
# vipsthumbnail makes the covers' small copies (thumbs.js).
RUN apt-get update && apt-get install -y --no-install-recommends libvips-tools && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

# The site's own dependencies (web/package.json, Max 2026-11-17: none of the reader's), in web/node_modules as on a
# laptop, so web/*.js and a release on the volume (its web/node_modules links here) find them the same way.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --omit=dev --no-audit --no-fund

COPY web ./web
# The read-only production view for threads (server/agent.js), shared with the reader.
COPY server/agent.js ./server/agent.js
COPY server/aimeter.js ./server/aimeter.js
# The commit, for /agent/health (web.yml passes it).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
COPY build/icon.png ./build/icon.png

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "web/main.js"]
