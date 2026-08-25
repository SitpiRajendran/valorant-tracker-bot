# Stage 1: Build TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production Runner
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
# Database will be stored here, mounted as a volume in Coolify
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/tracker.db
CMD ["node", "dist/index.js"]