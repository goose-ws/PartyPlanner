# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Non-root: alpine's node image ships a `node` user already.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
