# Playwright's official image: Chromium + all system libs preinstalled.
# The tag must match the playwright-core version pinned in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Persistent state (rate-limit history, unfollow log, screenshots) goes in the mounted /data volume.
ENV NODE_ENV=production DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["node", "src/cli.js"]
