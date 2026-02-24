# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production

# Stage 2: Production runtime
FROM node:20-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
ENV NODE_ENV=production
ENV ELASTIC_APM_SERVICE_NAME=notification-svc
ENV ELASTIC_APM_SERVER_URL=http://elastic-agent:8200
ENV ELASTIC_APM_ENVIRONMENT=production
ENV ELASTIC_APM_LOG_LEVEL=info
USER node
EXPOSE 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8083/health || exit 1
CMD ["dumb-init", "node", "-r", "elastic-apm-node/start.js", "src/index.js"]
