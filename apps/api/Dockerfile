# ============================================================================
# PRODUCTION CONTAINER DEFINITION FOR @titrate-health/api
# ============================================================================
FROM node:22-alpine

# Install OpenSSL required by Prisma Query Engine on Alpine Linux
RUN apk add --no-cache openssl

WORKDIR /app

# 1. Copy workspace manifests first to leverage Docker layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# 2. Install deterministic dependencies from lockfile
RUN npm ci

# 3. Copy source code & Prisma schema
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# 4. Generate Prisma Client for Alpine Linux target
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# 5. Principle of Least Privilege: Drop root privileges and run as 'node' user
USER node

EXPOSE 4000

# 6. Native Docker Healthcheck probing our /api/health PostgreSQL readiness endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4000/api/health || exit 1

CMD ["npm", "run", "dev:api"]