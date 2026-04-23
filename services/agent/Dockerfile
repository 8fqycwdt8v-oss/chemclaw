# Multi-stage build for the agent service.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/agent/package.json services/agent/
RUN npm install --workspaces --include-workspace-root
COPY services/agent/tsconfig.json services/agent/
COPY services/agent/src services/agent/src
RUN npm run build --workspace services/agent

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/services/agent/dist /app/dist
COPY --from=builder /app/services/agent/package.json /app/package.json
USER app
EXPOSE 3100
CMD ["node", "dist/index.js"]
