# Playwright's official image: Chromium + all system libs preinstalled.
# The tag must match the playwright-core version pinned in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY web ./web

# Persistent state (settings, rate-limit history, unfollow log, screenshots) lives in the /data volume.
# Everything runs as the unprivileged "pwuser" that ships with the Playwright image.
RUN mkdir -p /data && chown pwuser:pwuser /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8080
USER pwuser

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Default: the web dashboard (needs UI_PASSWORD). The command-line mode still works:
#   docker run --rm --env-file .env -v "$PWD/data:/data" <image> node src/cli.js
CMD ["node", "src/web.js"]
