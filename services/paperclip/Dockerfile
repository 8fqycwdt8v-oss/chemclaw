FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---
FROM node:22-alpine AS runner
WORKDIR /app

# Run as non-root (OpenShift SCC requirement).
RUN addgroup -S chemclaw && adduser -S -G chemclaw -u 1001 chemclaw
USER 1001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV PAPERCLIP_SKIP_START=false
ENV NODE_ENV=production

EXPOSE 3200

CMD ["node", "dist/src/index.js"]
