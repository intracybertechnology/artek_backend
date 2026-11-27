# ── ARTEK backend – production image ─────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies first, so this layer stays cached when only code changes
COPY package*.json ./
RUN npm ci --omit=dev

# Application source (node_modules, .env, uploads and .git are excluded
# by .dockerignore)
COPY . .

# Uploads folder owned by the unprivileged "node" user
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Never run the API as root
USER node

EXPOSE 5000

CMD ["node", "server.js"]
