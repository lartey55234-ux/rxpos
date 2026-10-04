# Node 24 is required: the app leans on the built-in node:sqlite module.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY db ./db
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Bundle the UI, then drop the build tooling from the runtime image.
RUN npm run build && npm prune --omit=dev

ENV DATA_DIR=/data PORT=4173
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4173
CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/serve.ts"]
