FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so this layer is cached across code changes. Electron is a devDependency
# and stays out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY server ./server
COPY build/icon.png build/landing-desk.jpg build/landing-phone.jpg ./build/
COPY demo ./demo

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/index.js"]
