# --- Backend build stage ---
FROM node:20-alpine AS build-backend
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Frontend build stage ---
FROM node:20-alpine AS build-frontend
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# --- Runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build-backend /build/dist ./dist
COPY --from=build-frontend /build/dist ./web/dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Non-root: alpine's node image ships a `node` user already.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
