FROM node:20-alpine

# Statuses are computed in America/Toronto; tzdata keeps that resolvable.
RUN apk add --no-cache tzdata
ENV TZ=America/Toronto

WORKDIR /app

# Install with devDependencies present — tsc is needed for the build below.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# src/web/public and src/data are not compiled; they are read from src at runtime.
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
