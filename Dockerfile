FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/server.js server/app-check.js server/operations.js server/imageMetadata.js ./
COPY server/storage ./storage
COPY server/ai ./ai
COPY server/scripts/backup.js server/scripts/postgres-cli.mjs server/scripts/migrate-to-postgres.mjs server/scripts/export-from-postgres.mjs ./scripts/
RUN mkdir -p data && chown node:node data
USER node
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
