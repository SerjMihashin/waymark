FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app

# better-sqlite3 needs build tools at runtime on alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations

VOLUME ["/app/data"]
EXPOSE 3747

ENV NODE_ENV=production
ENV PORT=3747

CMD ["node", "dist/server.js", "--http"]
