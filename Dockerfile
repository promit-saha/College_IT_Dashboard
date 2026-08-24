FROM node:22-alpine

# Non-root user, standard hardening, nothing here needs root.
RUN addgroup -S dashboard && adduser -S dashboard -G dashboard

WORKDIR /app

# Dependencies in their own layer, so a plain code edit doesn't force a
# full npm reinstall on every rebuild.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js auth.js cache.js ./
COPY sources/ ./sources/
COPY public/ ./public/
COPY services.txt ./services.txt

# .env and sessions.json are deliberately NOT copied in here, both are
# supplied at runtime instead (see docker-compose.yml), .env because it
# holds real secrets that shouldn't ever be baked into a distributable
# image, sessions.json because it needs to survive the container being
# recreated, not just restarted.

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

USER dashboard

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
