# Chytai web platform. Built from the repo root (fly.toml in web/ points here; flyctl -c web/fly.toml).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY web ./web
COPY build/icon.png ./build/icon.png

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "web/main.js"]
